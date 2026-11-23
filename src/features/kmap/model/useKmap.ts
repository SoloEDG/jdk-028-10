/**
 * 卡诺图实验的编辑状态：圈组、锁定、目标选择、变量顺序、方案浏览与比较。
 *
 * 关键规则：
 *  - 圈组只按“固定变量取值”保存，不依赖网格位置；切换变量顺序后仍然
 *    对应同一组输入组合。
 *  - 锁定是显式的；求解时把锁定项作为约束交给求解器，决不会暗中解锁。
 *  - 锁定时同时保留“未锁定最优”作为比较基准；若锁定使全局最优变差，
 *    两个成本并排展示。
 */
import { computed, ref, watch, type Ref } from "vue";
import type { CircuitDocument } from "@/shared/types";
import {
  solutionKey,
  solve,
  type CellValue,
  type Solution,
  type TermAssignment,
} from "../lib/minimize";
import { presets, presetById, type KmapPreset } from "../lib/presets";
import {
  checkGroup,
  cellsToTerm,
  sameTerm,
  termKey,
  type Fixed,
  type GroupCheck,
  type GroupTerm,
} from "../lib/terms";
import {
  buildCircuit,
  expressionsFor,
  verifyTerms,
  type BuildResult,
} from "../lib/circuit";
import { layoutFor, positionMap, type Bit } from "../lib/grid";

export interface KmapGroup extends GroupTerm {
  id: string;
  locked: boolean;
  /** 由学生手动圈定（否则来自方案浏览）。 */
  manual: boolean;
}

export interface SolveSnapshot {
  best: number | null;
  terms: TermAssignment[];
  breakdown: { andGates: number; orGates: number; notGates: number; total: number };
  proven: boolean;
  aborted: boolean;
  nodes: number;
  elapsedMs: number;
  candidates: number;
}

export interface StudentCheck {
  groups: {
    group: KmapGroup;
    check: GroupCheck;
  }[];
  uncoveredByOutput: { label: string; cells: number[] }[];
  illegal: number;
  complete: boolean;
  cost: {
    andGates: number;
    orGates: number;
    notGates: number;
    total: number;
  };
  /** 学生方案里没有任何圈组服务的输出。 */
  missingOutputs: string[];
}

const SOLVE_BUDGET = { budget: 260_000, timeMs: 1200, want: 6 };
const SOLVE_ALT_BUDGET = { budget: 90_000, timeMs: 900, want: 1 };

let counter = 0;
const nextId = () => `g${++counter}`;

export function useKmap(
  document: Ref<CircuitDocument>,
  applyDocument: (next: CircuitDocument) => void = (next) => {
    document.value = next;
  },
) {
  const presetId = ref(presets[0].id);
  const preset = computed<KmapPreset>(() => presetById(presetId.value));
  /** 变量顺序：picked = 显示顺序里的变量 canonical 下标。 */
  const variableOrder = ref<number[]>([0, 1, 2, 3, 4, 5]);
  const order = computed(() =>
    variableOrder.value.slice(0, preset.value.variables.length),
  );
  const layout = computed(() => layoutFor(preset.value.variables.length, order.value));
  const positions = computed(() => positionMap(layout.value));
  const groups = ref<KmapGroup[]>([]);
  const activeOutput = ref(0);
  const selectedGroup = ref<string | null>(null);
  const inspected = ref(false);
  /** 只高亮当前输出的未覆盖格；由面板开关控制。 */
  const showUncovered = ref(true);
  const comparison = ref<SolveSnapshot | null>(null);
  const unrestricted = ref<SolveSnapshot | null>(null);
  const independent = ref<{ best: number; parts: { label: string; best: number | null }[] } | null>(null);
  const solutions = ref<{ solution: Solution; locked: boolean }[]>([]);
  const solutionIndex = ref(0);
  const solving = ref(false);
  const solverNote = ref("");
  const buildResult = ref<BuildResult | null>(null);

  const variables = computed(() =>
    order.value.map((index) => preset.value.variables[index]),
  );
  const rowVars = computed(() => layout.value.rowVars);
  const colVars = computed(() => layout.value.colVars);
  const layerVars = computed(() => layout.value.layerVars);

  function resetAll() {
    reset(preset.value);
  }

  function reset(presetValue: KmapPreset) {
    groups.value = [];
    selectedGroup.value = null;
    inspected.value = false;
    activeOutput.value = 0;
    solutions.value = [];
    solutionIndex.value = 0;
    comparison.value = null;
    unrestricted.value = null;
    buildResult.value = null;
    solverNote.value = "";
    variableOrder.value = Array.from({ length: presetValue.variables.length }, (_, i) => i);
  }

  /** 把变量顺序整体循环移位（只换显示，不影响任何 cell 对应关系）。 */
  function rotateOrder() {
    const count = preset.value.variables.length;
    if (count < 2) return;
    const current = order.value;
    variableOrder.value = [...current.slice(1), current[0]];
  }

  function swapOrder(a: number, b: number) {
    const next = [...order.value];
    const temp = next[a];
    next[a] = next[b];
    next[b] = temp;
    variableOrder.value = next;
  }

  watch(presetId, () => {
    reset(preset.value);
  });

  const tables = computed(() =>
    preset.value.outputs.map((output) => ({
      label: output.label,
      cells: output.cells as readonly CellValue[],
    })),
  );

  function coveredCells(output: number): Set<number> {
    const covered = new Set<number>();
    const n = preset.value.variables.length;
    for (const group of groups.value) {
      if (!group.outputs.includes(output)) continue;
      for (let cell = 0; cell < 1 << n; cell++) {
        let matches = true;
        for (let i = 0; i < n; i++)
          if (group.fixed[i] !== -1 && ((cell >> i) & 1) !== group.fixed[i]) {
            matches = false;
            break;
          }
        if (matches) covered.add(cell);
      }
    }
    return covered;
  }

  const studentCheck = computed<StudentCheck>(() => {
    const coveredByOutput = preset.value.outputs.map((_, index) => coveredCells(index));
    const checkList = groups.value.map((group) => ({
      group,
      check: checkGroup(group.fixed, group.outputs, tables.value, coveredByOutput),
    }));
    const uncoveredByOutput = preset.value.outputs.map((output, outputIndex) => {
      const covered = coveredByOutput[outputIndex];
      const cells: number[] = [];
      output.cells.forEach((value, cell) => {
        if (value === 1 && !covered.has(cell)) cells.push(cell);
      });
      return { label: output.label, cells };
    });
    const missingOutputs = preset.value.outputs
      .filter((output, index) => {
        const hasOne = output.cells.includes(1);
        const hasGroup = groups.value.some((group) => group.outputs.includes(index));
        return hasOne && !hasGroup;
      })
      .map((output) => output.label);
    const illegal = checkList.filter((entry) => !entry.check.legal).length;
    const complete =
      illegal === 0 &&
      uncoveredByOutput.every((entry) => entry.cells.length === 0) &&
      missingOutputs.length === 0;

    // 成本：与最小化器同一口径；共享项只算一次。
    type Chart = { fixed: Fixed[]; outputs: number[] };
    const map = new Map<string, Chart>();
    for (const group of groups.value) {
      const key = termKey(group.fixed);
      const prior = map.get(key);
      if (prior) {
        for (const output of group.outputs)
          if (!prior.outputs.includes(output)) prior.outputs.push(output);
      } else map.set(key, { fixed: [...group.fixed], outputs: [...group.outputs] });
    }
    let andGates = 0;
    let orGates = 0;
    const notSet = new Set<number>();
    const termCounts = preset.value.outputs.map(() => 0);
    for (const chart of map.values()) {
      const literals = chart.fixed.filter((value) => value !== -1).length;
      andGates += Math.max(0, literals - 1);
      chart.fixed.forEach((value, index) => {
        if (value === 0) notSet.add(index);
      });
      for (const output of chart.outputs) termCounts[output]++;
    }
    for (const count of termCounts) orGates += Math.max(0, count - 1);
    return {
      groups: checkList,
      uncoveredByOutput,
      illegal,
      complete,
      cost: {
        andGates,
        orGates,
        notGates: notSet.size,
        total: andGates + orGates + notSet.size,
      },
      missingOutputs,
    };
  });

  function groupById(id: string): KmapGroup | undefined {
    return groups.value.find((group) => group.id === id);
  }

  function addGroup(cells: readonly number[], outputs: readonly number[]): string | null {
    const n = preset.value.variables.length;
    const fixed = cellsToTerm(cells, n);
    if (!fixed) return "圈住的格子不是矩形（乘积项），请重新圈定";
    const chosen = [...outputs];
    if (!chosen.length) return "请选择这条圈组要服务的输出";
    const duplicate = groups.value.find(
      (group) =>
        sameTerm(group.fixed, fixed) &&
        group.outputs.length === chosen.length &&
        group.outputs.every((value, index) => value === chosen[index]),
    );
    if (duplicate) {
      selectedGroup.value = duplicate.id;
      return null;
    }
    const check = checkGroup(fixed, chosen, tables.value);
    if (check.wildcardsOnly)
      return "这个圈组只覆盖无关项，没有任何输出因此为 1，不能使用";
    const group: KmapGroup = {
      id: nextId(),
      fixed,
      outputs: chosen,
      locked: false,
      manual: true,
    };
    groups.value.push(group);
    selectedGroup.value = group.id;
    comparison.value = null;
    solutions.value = [];
    return check.legal ? null : `圈组含必须为 0 的格子（${check.zeroCells.length} 个），已标红`;
  }

  function removeGroup(id: string) {
    groups.value = groups.value.filter((group) => group.id !== id);
    if (selectedGroup.value === id) selectedGroup.value = null;
    comparison.value = null;
    solutions.value = [];
  }

  function toggleLock(id: string) {
    const group = groupById(id);
    if (!group) return;
    const check = checkGroup(group.fixed, group.outputs, tables.value);
    if (!check.legal) {
      solverNote.value = "含必须为 0 格子的圈组不能锁定，请先修正";
      return;
    }
    group.locked = !group.locked;
    comparison.value = null;
  }

  function setOutputs(id: string, outputs: number[]) {
    const group = groupById(id);
    if (!group) return;
    const sorted = [...new Set(outputs)].sort((a, b) => a - b);
    if (!sorted.length) return;
    const check = checkGroup(group.fixed, sorted, tables.value);
    if (!check.legal) {
      // 锁定是显式状态：不会为了接受新输出而暗中解锁。
      solverNote.value = group.locked
        ? "该圈组对新输出含必须为 0 的格子；锁定保持不变，请先解锁再修改"
        : "该圈组对这些输出含必须为 0 的格子，未修改";
      return;
    }
    if (check.wildcardsOnly) {
      solverNote.value = "这些输出在该圈组上全是无关项，圈组无用，未修改";
      return;
    }
    group.outputs = sorted;
    comparison.value = null;
  }

  function undoLastGroup() {
    const last = groups.value[groups.value.length - 1];
    if (last) removeGroup(last.id);
  }

  function clearGroups() {
    groups.value = [];
    selectedGroup.value = null;
    inspected.value = false;
    buildResult.value = null;
    comparison.value = null;
    solutions.value = [];
  }

  function inspect() {
    inspected.value = true;
  }

  function setVariableOrder(next: number[]) {
    const n = preset.value.variables.length;
    if (next.length !== n || new Set(next).size !== n) return;
    variableOrder.value = next;
    // 圈组按 cell 定义，与顺序无关：这里不做任何格子映射。
  }

  function lockedTerms(): TermAssignment[] {
    return groups.value
      .filter((group) => group.locked)
      .map((group) => ({ fixed: [...group.fixed], outputs: [...group.outputs] }));
  }

  function targetSpec() {
    return {
      variables: preset.value.variables,
      outputs: preset.value.outputs.map((output) => ({
        id: output.id,
        label: output.label,
        cells: output.cells,
      })),
    };
  }

  /** 逐输出独立最小化，仅作对照：用来证明共享网络可能更便宜。 */
  function independentMinima(): { best: number; parts: { label: string; best: number | null }[] } {
    const parts = preset.value.outputs.map((output) => {
      const result = solve(
        {
          variables: preset.value.variables,
          outputs: [{ id: output.id, label: output.label, cells: output.cells }],
        },
        { budget: 60_000, timeMs: 500, want: 1 },
      );
      return { label: output.label, best: result.best };
    });
    const best = parts.reduce((sum, part) => sum + (part.best ?? 0), 0);
    return { best, parts };
  }

  /** 求解结果必须完整保留每一条锁定项；否则视为工具错误并保留学生方案。 */
  function lockedTermsMissing(terms: readonly TermAssignment[], locked: readonly TermAssignment[]): TermAssignment[] {
    return locked.filter(
      (lock) =>
        !terms.some(
          (term) =>
            term.fixed.join("") === lock.fixed.join("") &&
            lock.outputs.every((output) => term.outputs.includes(output)),
        ),
    );
  }

  function runSolve(
    locked: readonly TermAssignment[],
    budget = SOLVE_BUDGET,
  ): SolveSnapshot {
    const result = solve(targetSpec(), { ...budget, locked });
    const terms = result.solutions[0]?.terms ?? [];
    return {
      best: result.best,
      terms,
      breakdown: result.solutions[0]?.breakdown ?? costBreakdown(terms),
      proven: result.proven,
      aborted: result.aborted,
      nodes: result.nodes,
      elapsedMs: result.elapsedMs,
      candidates: result.candidates,
    };
  }

  function solveAll() {
    solving.value = true;
    const start = performance.now();
    try {
      const base = runSolve([], SOLVE_BUDGET);
      unrestricted.value = base;
      independent.value = independentMinima();
      const locked = lockedTerms();
      const restricted = locked.length ? runSolve(locked, SOLVE_BUDGET) : base;
      comparison.value = restricted;
      const missing = lockedTermsMissing(restricted.terms, locked);
      if (missing.length) {
        solverNote.value = `求解器没有保留 ${missing.length} 条锁定项，已停止采用该结果；画布上的学生方案未改动`;
        solutions.value = [];
        return;
      }
      const records: { solution: Solution; locked: boolean }[] = [];
      if (restricted.terms.length)
        records.push({
          solution: {
            cost: restricted.best!,
            terms: restricted.terms,
            breakdown: restricted.breakdown,
          },
          locked: locked.length > 0,
        });
      // 浏览其它同等最优解：不断用 exclude 跳过已收集的方案，直到找不到新方案。
      let exclude = records.map((record) => record.solution.terms);
      let guard = 0;
      while (exclude.length < 6 && guard++ < 8) {
        const more = solve(targetSpec(), { ...SOLVE_ALT_BUDGET, locked, exclude });
        if (!more.solutions.length || more.best !== restricted.best) break;
        let added = 0;
        for (const solution of more.solutions) {
          if (
            records.some(
              (record) => solutionKey(record.solution.terms) === solutionKey(solution.terms),
            )
          )
            continue;
          if (lockedTermsMissing(solution.terms, locked).length) continue;
          records.push({ solution, locked: locked.length > 0 });
          added++;
        }
        exclude = records.map((record) => record.solution.terms);
        if (!added) break;
      }
      solutions.value = records;
      solutionIndex.value = 0;
      // 求解后直接展开覆盖检查：未覆盖的 1、误圈的 0、门成本与乘积项都在这里。
      if (groups.value.length) inspected.value = true;
      const elapsed = performance.now() - start;
      solverNote.value = restricted.aborted
        ? `搜索达到预算，已停止；当前最优 ${restricted.best ?? "—"} 门（未证明最优）`
        : `已完成：全局最优 ${restricted.best ?? "—"} 门，用时 ${elapsed.toFixed(0)} ms`;
      if (independent.value && base.best !== null) {
        const saved = independent.value.best - base.best;
        solverNote.value += `；逐输出独立最少合计 ${independent.value.best} 门，共用项网络${saved > 0 ? "更省 " + saved + " 门" : saved === 0 ? "成本相同" : "反而多 " + -saved + " 门"}`;
      }
      if (locked.length && base.best !== null && restricted.best !== null) {
        if (restricted.best > base.best)
          solverNote.value += `；锁定使最优从 ${base.best} 门变差到 ${restricted.best} 门（未解锁）`;
        else solverNote.value += `；锁定方案与未锁定最优相同（${base.best} 门）`;
      }
    } finally {
      solving.value = false;
    }
  }

  function costBreakdown(terms: readonly TermAssignment[]) {
    const map = new Map<string, { fixed: Fixed[]; outputs: number[] }>();
    for (const term of terms) {
      const key = term.fixed.join("");
      const prior = map.get(key);
      if (prior) {
        for (const output of term.outputs)
          if (!prior.outputs.includes(output)) prior.outputs.push(output);
      } else map.set(key, { fixed: [...term.fixed], outputs: [...term.outputs] });
    }
    let andGates = 0;
    const notSet = new Set<number>();
    const counts = preset.value.outputs.map(() => 0);
    for (const chart of map.values()) {
      andGates += Math.max(0, chart.fixed.filter((value) => value !== -1).length - 1);
      chart.fixed.forEach((value, index) => {
        if (value === 0) notSet.add(index);
      });
      for (const output of chart.outputs) counts[output]++;
    }
    let orGates = 0;
    for (const count of counts) orGates += Math.max(0, count - 1);
    return {
      andGates,
      orGates,
      notGates: notSet.size,
      total: andGates + orGates + notSet.size,
    };
  }

  /** 只预览（不覆盖学生画布上的圈组）。 */
  function browseSolution(index: number) {
    if (!solutions.value[index]) return;
    solutionIndex.value = index;
  }

  function adoptSolution(index: number) {
    const record = solutions.value[index];
    if (!record) return;
    solutionIndex.value = index;
    const priorLocked = groups.value.filter((group) => group.locked);
    groups.value = record.solution.terms.map((term) => ({
      id: nextId(),
      fixed: [...term.fixed],
      outputs: [...term.outputs],
      // 采用方案时保留原来的锁定状态，绝不因为“换方案”而暗中解锁。
      locked: priorLocked.some(
        (group) =>
          group.fixed.join("") === term.fixed.join("") &&
          group.outputs.every((output) => term.outputs.includes(output)),
      ),
      manual: false,
    }));
    selectedGroup.value = null;
    // 方案落到画布后仍然展开覆盖检查，学生可以立刻看到覆盖与门成本。
    inspected.value = true;
  }

  function adoptTerms(terms: readonly TermAssignment[], locked: boolean) {
    groups.value = terms.map((term) => ({
      id: nextId(),
      fixed: [...term.fixed],
      outputs: [...term.outputs],
      locked,
      manual: false,
    }));
    selectedGroup.value = null;
    inspected.value = groups.value.length > 0;
  }

  const currentSolution = computed(() => solutions.value[solutionIndex.value] ?? null);

  function generateCircuit() {
    if (studentCheck.value.illegal > 0) {
      buildResult.value = null;
      solverNote.value = "有圈组含必须为 0 的格子，先修正再生成电路";
      return;
    }
    const terms = groups.value.map((group) => ({
      fixed: [...group.fixed] as Fixed[],
      outputs: [...group.outputs],
    }));
    const mismatch = verifyTerms(terms, preset.value);
    const result = buildCircuit(terms, preset.value, `卡诺图 · ${preset.value.title}`);
    buildResult.value = result;
    if (!result.error && !mismatch.length) {
      applyDocument(result.document);
      presetId.value = preset.value.id;
    }
  }

  const expressions = computed(() =>
    expressionsFor(
      groups.value.map((group) => ({ fixed: group.fixed, outputs: group.outputs })),
      preset.value.variables,
      preset.value.outputs,
    ),
  );

  return {
    presets,
    presetId,
    preset,
    resetAll,
    order,
    variables,
    rowVars,
    colVars,
    layerVars,
    rotateOrder,
    swapOrder,
    layout,
    positions,
    groups,
    selectedGroup,
    activeOutput,
    inspected,
    showUncovered,
    comparison,
    unrestricted,
    independent,
    solutions,
    solutionIndex,
    currentSolution,
    solving,
    solverNote,
    buildResult,
    studentCheck,
    expressions,
    addGroup,
    removeGroup,
    undoLastGroup,
    clearGroups,
    inspect,
    toggleLock,
    setOutputs,
    setVariableOrder,
    solveAll,
    browseSolution,
    adoptSolution,
    adoptTerms,
    lockedTerms,
    generateCircuit,
    groupsForCell: computed(() => {
      const index = new Map<number, KmapGroup[]>();
      const n = preset.value.variables.length;
      for (const group of groups.value)
        for (let cell = 0; cell < 1 << n; cell++) {
          let matches = true;
          for (let i = 0; i < n; i++)
            if (group.fixed[i] !== -1 && ((cell >> i) & 1) !== group.fixed[i]) {
              matches = false;
              break;
            }
          if (!matches) continue;
          const list = index.get(cell) ?? [];
          list.push(group);
          index.set(cell, list);
        }
      return index;
    }),
    cellBits: (cell: number): Bit[] => {
      const n = preset.value.variables.length;
      return Array.from({ length: n }, (_, i) => ((cell >> i) & 1) as Bit);
    },
  };
}
