/**
 * 卡诺图 → 电路。
 *
 * 生成的网络把共享项真正接成一根项线：一个乘积项的与门输出同时接到
 * 多个输出各自的或树，而不是为每个输出复制一份。只使用二输入门，
 * 与 minimize.ts 的门成本口径一致。
 *
 * 生成前后各验证一次：
 *  1. 表达式逐格对照目标表（无关项跳过）；
 *  2. 用真实电路仿真 evaluate() 遍历全部输入，核对每个输出引脚。
 * 任一不一致都不返回电路。
 */
import type { CircuitDocument, GateNode, Wire } from "@/shared/types";
import { topologicalOrder } from "@/features/circuit/lib/graph";
import { evaluate } from "@/features/simulation/lib/evaluate";
import type { CellValue, TermAssignment } from "./minimize";
import type { KmapPreset } from "./presets";
import type { Fixed } from "./terms";

export interface BuildMismatch {
  output: string;
  cell: number;
  expected: CellValue;
  actual: string;
  source: string;
}

export interface BuildResult {
  document: CircuitDocument;
  expressions: string[];
  gateCount: number;
  connections: number;
  mismatches: BuildMismatch[];
  error: string | null;
  /** 生成时静态核对的格子数（无关项不计）。 */
  checkedCells: number;
  /** 生成时用真实电路仿真核对的格子数（无关项不计）。 */
  simulatedCells: number;
  /** 目标表快照，供电路侧复核展示。 */
  presetId: string;
  variables: string[];
  outputs: { label: string; cells: CellValue[] }[];
  /** 仿真得到的逐格实际值，与目标表一一对应；无关项为 null。 */
  actual: (0 | 1 | null)[][];
  /** 共享项（同一乘积项服务的输出数 > 1）数量。 */
  sharedTerms: number;
}

interface AbstractGate {
  key: string;
  kind: GateNode["kind"];
  label: string;
  inputs: string[];
  depth: number;
}

function cellValueOf(
  terms: readonly TermAssignment[],
  output: number,
  cell: number,
): 0 | 1 {
  let value: 0 | 1 = 0;
  for (const term of terms) {
    if (!term.outputs.includes(output)) continue;
    let matches = true;
    for (let i = 0; i < term.fixed.length; i++) {
      const fixed = term.fixed[i];
      if (fixed !== -1 && ((cell >> i) & 1) !== fixed) {
        matches = false;
        break;
      }
    }
    if (matches) value = 1;
  }
  return value;
}

export function verifyTerms(
  terms: readonly TermAssignment[],
  preset: KmapPreset,
): BuildMismatch[] {
  const n = preset.variables.length;
  const mismatches: BuildMismatch[] = [];
  preset.outputs.forEach((output, index) => {
    for (let cell = 0; cell < 1 << n; cell++) {
      const expected = output.cells[cell];
      if (expected === "X") continue;
      const actual = cellValueOf(terms, index, cell);
      if (actual !== expected)
        mismatches.push({
          output: output.label,
          cell,
          expected,
          actual: String(actual),
          source: "表达式",
        });
    }
  });
  return mismatches;
}

export function expressionFor(
  output: number,
  terms: readonly TermAssignment[],
  variables: readonly string[],
): string {
  const parts = terms
    .filter((term) => term.outputs.includes(output))
    .map((term) => {
      const literals: string[] = [];
      term.fixed.forEach((value, index) => {
        if (value === -1) return;
        literals.push(`${variables[index]}${value === 0 ? "̅" : ""}`);
      });
      return literals.length ? literals.join("·") : "1";
    });
  return parts.length ? parts.join(" + ") : "0";
}

export function expressionsFor(
  terms: readonly TermAssignment[],
  variables: readonly string[],
  outputs: readonly { label: string }[],
): string[] {
  return outputs.map(
    (output, index) => `${output.label} = ${expressionFor(index, terms, variables)}`,
  );
}

function mergeTerms(terms: readonly TermAssignment[]): { fixed: Fixed[]; outputs: number[] }[] {
  const map = new Map<string, { fixed: Fixed[]; outputs: number[] }>();
  for (const term of terms) {
    const key = term.fixed.join("");
    const prior = map.get(key);
    if (prior) {
      for (const output of term.outputs)
        if (!prior.outputs.includes(output)) prior.outputs.push(output);
    } else map.set(key, { fixed: [...term.fixed], outputs: [...term.outputs] });
  }
  return [...map.values()];
}

function termLabel(fixed: readonly Fixed[], variables: readonly string[]): string {
  const parts = fixed
    .map((value, index) => (value === -1 ? null : `${variables[index]}${value === 0 ? "′" : ""}`))
    .filter(Boolean);
  return parts.length ? parts.join("·") : "1";
}

/**
 * 画布布局：按依赖深度分列，同列按出现顺序分行。
 * 生成的电路可能比默认工作台更大，CircuitBoard 会自动扩展视图。
 */
function layout(gates: AbstractGate[]): Map<string, { x: number; y: number }> {
  const byDepth = new Map<number, AbstractGate[]>();
  for (const gate of gates) {
    const list = byDepth.get(gate.depth) ?? [];
    list.push(gate);
    byDepth.set(gate.depth, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, list] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((gate, row) => {
      positions.set(gate.key, { x: 60 + depth * 168, y: 60 + row * 108 });
    });
  }
  return positions;
}

export function buildCircuit(
  terms: readonly TermAssignment[],
  preset: KmapPreset,
  name?: string,
): BuildResult {
  const expressions = expressionsFor(terms, preset.variables, preset.outputs);
  const expressionMismatches = verifyTerms(terms, preset);
  if (expressionMismatches.length)
    return {
      ...failedResult(
        expressions,
        preset,
        `表达式与目标表有 ${expressionMismatches.length} 处不一致，已停止生成`,
      ),
      mismatches: expressionMismatches,
    };

  const gates: AbstractGate[] = [];
  const addGate = (
    key: string,
    kind: GateNode["kind"],
    label: string,
    inputs: string[],
  ) => {
    const depth = inputs.reduce((max, input) => {
      const source = gates.find((gate) => gate.key === input);
      return Math.max(max, source ? source.depth + 1 : 0);
    }, 0);
    gates.push({ key, kind, label, inputs, depth });
    return key;
  };

  const inputKeys = preset.variables.map((variable, index) =>
    addGate(`in-${index}`, "INPUT", variable, []),
  );
  const notKeys = new Map<number, string>();
  const merged = mergeTerms(terms);
  const inverted = new Set<number>();
  for (const term of merged)
    term.fixed.forEach((value, index) => {
      if (value === 0) inverted.add(index);
    });
  for (const index of [...inverted].sort((a, b) => a - b))
    notKeys.set(
      index,
      addGate(`not-${index}`, "NOT", `NOT ${preset.variables[index]}`, [inputKeys[index]]),
    );

  const termKeys = new Map<string, string>();
  merged
    .slice()
    .sort(
      (a, b) =>
        b.fixed.filter((v) => v !== -1).length - a.fixed.filter((v) => v !== -1).length,
    )
    .forEach((term, index) => {
      const literals = term.fixed
        .map((value, position) => ({ value, position }))
        .filter((entry) => entry.value !== -1);
      const key = `term-${index}`;
      const label = `P${index + 1} ${termLabel(term.fixed, preset.variables)}`;
      if (literals.length === 0) {
        termKeys.set(term.fixed.join(""), addGate(key, "CONST1", label, []));
        return;
      }
      let accumulator =
        literals[0].value === 0
          ? notKeys.get(literals[0].position)!
          : inputKeys[literals[0].position];
      if (literals.length === 1) {
        termKeys.set(term.fixed.join(""), accumulator);
        return;
      }
      for (let i = 1; i < literals.length; i++) {
        const source =
          literals[i].value === 0
            ? notKeys.get(literals[i].position)!
            : inputKeys[literals[i].position];
        accumulator = addGate(`${key}-${i}`, "AND", label, [accumulator, source]);
      }
      termKeys.set(term.fixed.join(""), accumulator);
    });

  preset.outputs.forEach((output, outputIndex) => {
    const keys = merged
      .filter((term) => term.outputs.includes(outputIndex))
      .map((term) => termKeys.get(term.fixed.join(""))!);
    const outputKey = `out-${outputIndex}`;
    if (!keys.length) {
      const zero = addGate(`zero-${outputIndex}`, "CONST0", `${output.label} = 0`, []);
      addGate(outputKey, "OUTPUT", output.label, [zero]);
      return;
    }
    let accumulator = keys[0];
    for (let i = 1; i < keys.length; i++)
      accumulator = addGate(
        `or-${outputIndex}-${i}`,
        "OR",
        `OR ${output.label}`,
        [accumulator, keys[i]],
      );
    addGate(outputKey, "OUTPUT", output.label, [accumulator]);
  });

  const positions = layout(gates);
  const nodes: GateNode[] = gates.map((gate) => {
    const position = positions.get(gate.key)!;
    return {
      id: gate.key,
      kind: gate.kind,
      label: gate.label,
      value: 0,
      x: position.x,
      y: position.y,
    };
  });
  const wires: Wire[] = [];
  for (const gate of gates)
    gate.inputs.forEach((source, port) => {
      wires.push({
        id: `wire-${wires.length + 1}`,
        from: { nodeId: source, port: 0 },
        to: { nodeId: gate.key, port },
      });
    });

  const document: CircuitDocument = {
    version: 1,
    name: name ?? `卡诺图 · ${preset.title}`,
    targetId: "xor",
    nodes,
    wires,
  };

  try {
    topologicalOrder(document);
  } catch {
    return failedResult(expressions, preset, "生成的电路出现反馈环，已停止生成");
  }

  const simulated = simulateCircuit(document, preset);
  if (simulated.mismatches.length)
    return {
      ...failedResult(
        expressions,
        preset,
        `电路仿真与目标表有 ${simulated.mismatches.length} 处不一致，已停止生成`,
      ),
      mismatches: simulated.mismatches,
      actual: simulated.actual,
      simulatedCells: simulated.checked,
    };

  const termCounts = new Map<string, number>();
  for (const term of merged) termCounts.set(term.fixed.join(""), term.outputs.length);
  return {
    document,
    expressions,
    gateCount: nodes.filter((node) => node.kind !== "INPUT" && node.kind !== "OUTPUT").length,
    connections: wires.length,
    mismatches: [],
    error: null,
    checkedCells: countChecked(preset),
    simulatedCells: simulated.checked,
    presetId: preset.id,
    variables: [...preset.variables],
    outputs: preset.outputs.map((output) => ({
      label: output.label,
      cells: [...output.cells],
    })),
    actual: simulated.actual,
    sharedTerms: [...termCounts.values()].filter((count) => count > 1).length,
  };
}

function countChecked(preset: KmapPreset): number {
  return preset.outputs.reduce(
    (sum, output) => sum + output.cells.filter((value) => value !== "X").length,
    0,
  );
}

function failedResult(
  expressions: string[],
  preset: KmapPreset,
  error: string,
): BuildResult {
  return {
    document: emptyDocument(),
    expressions,
    gateCount: 0,
    connections: 0,
    mismatches: [],
    error,
    checkedCells: countChecked(preset),
    simulatedCells: 0,
    presetId: preset.id,
    variables: [...preset.variables],
    outputs: preset.outputs.map((output) => ({
      label: output.label,
      cells: [...output.cells],
    })),
    actual: [],
    sharedTerms: 0,
  };
}

function simulateCircuit(
  document: CircuitDocument,
  preset: KmapPreset,
): { mismatches: BuildMismatch[]; actual: (0 | 1 | null)[][]; checked: number } {
  const n = preset.variables.length;
  const inputNodes = preset.variables.map((variable) =>
    document.nodes.find((node) => node.kind === "INPUT" && node.label === variable),
  );
  const outputNodes = preset.outputs.map((output) =>
    document.nodes.find((node) => node.kind === "OUTPUT" && node.label === output.label),
  );
  const actual: (0 | 1 | null)[][] = preset.outputs.map(() =>
    Array.from({ length: 1 << n }, () => null),
  );
  if (inputNodes.some((node) => !node) || outputNodes.some((node) => !node)) {
    const mismatches: BuildMismatch[] = preset.outputs.map((output) => ({
      output: output.label,
      cell: -1,
      expected: 1,
      actual: "缺少输入或输出端子",
      source: "电路",
    }));
    return { mismatches, actual, checked: 0 };
  }
  const mismatches: BuildMismatch[] = [];
  let checked = 0;
  const overrides: Record<string, 0 | 1> = {};
  for (let cell = 0; cell < 1 << n; cell++) {
    inputNodes.forEach((node, index) => {
      overrides[node!.id] = ((cell >> index) & 1) as 0 | 1;
    });
    const signals = evaluate(document, overrides);
    preset.outputs.forEach((output, index) => {
      const expected = output.cells[cell];
      if (expected === "X") return;
      checked++;
      const value = signals.values[outputNodes[index]!.id];
      if (value === 0 || value === 1) actual[index][cell] = value;
      if (value !== expected)
        mismatches.push({
          output: output.label,
          cell,
          expected,
          actual: String(value),
          source: "电路仿真",
        });
    });
  }
  return { mismatches, actual, checked };
}

/** 用真实仿真逐格核对：输入开关 → 输出指示灯。 */
export function verifyCircuit(
  document: CircuitDocument,
  preset: KmapPreset,
): BuildMismatch[] {
  return simulateCircuit(document, preset).mismatches;
}

export function emptyDocument(): CircuitDocument {
  return { version: 1, name: "未命名实验", targetId: "xor", nodes: [], wires: [] };
}
