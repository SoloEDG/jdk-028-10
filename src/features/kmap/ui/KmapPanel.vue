<script setup lang="ts">
/**
 * 卡诺图实验台主面板。布局与现有实验台一致：左侧控制、中间画布、右侧结果。
 */
import { computed } from "vue";
import type { KmapPreset } from "../lib/presets";
import type { GridLayout } from "../lib/grid";
import type { StudentCheck } from "../model/useKmap";
import type { BuildResult } from "../lib/circuit";
import KmapBoard, { type BoardGroup } from "./KmapBoard.vue";

export interface KmapSolutionView {
  index: number;
  cost: number;
  andGates: number;
  orGates: number;
  notGates: number;
  terms: { text: string; outputs: number[] }[];
  locked: boolean;
}

const props = defineProps<{
  preset: KmapPreset;
  presets: readonly KmapPreset[];
  layout: GridLayout;
  variables: readonly string[];
  order: readonly number[];
  rowVars: readonly number[];
  colVars: readonly number[];
  layerVars: readonly number[];
  groups: readonly {
    id: string;
    fixed: readonly (0 | 1 | -1)[];
    outputs: readonly number[];
    locked: boolean;
    manual: boolean;
  }[];
  selectedGroup: string | null;
  activeOutput: number;
  check: StudentCheck;
  solving: boolean;
  note: string;
  unrestricted: { best: number | null; proven: boolean; aborted: boolean } | null;
  comparison: { best: number | null; proven: boolean; aborted: boolean } | null;
  independent: { best: number; parts: { label: string; best: number | null }[] } | null;
  solutions: readonly KmapSolutionView[];
  solutionIndex: number;
  expressions: readonly string[];
  build: BuildResult | null;
  inspected: boolean;
}>();

const emit = defineEmits<{
  choosePreset: [id: string];
  chooseOutput: [index: number];
  selectGroup: [id: string | null];
  toggleLock: [id: string];
  removeGroup: [id: string];
  setOutputs: [id: string, outputs: number[]];
  circle: [cells: number[]];
  rotateOrder: [];
  swapOrder: [a: number, b: number];
  solve: [];
  browse: [index: number];
  adopt: [index: number];
  generate: [];
  inspect: [];
  undo: [];
  clearGroups: [];
}>();

const boardGroups = computed<BoardGroup[]>(() =>
  props.groups.map((group) => {
    const illegal =
      group.outputs.some((output) =>
        expandCells(group.fixed).some(
          (cell) => props.preset.outputs[output]?.cells[cell] === 0,
        ),
      );
    return {
      id: group.id,
      fixed: group.fixed,
      outputs: group.outputs,
      locked: group.locked,
      illegal,
    };
  }),
);

const uncoveredCells = computed(() => {
  const entry = props.check.uncoveredByOutput[props.activeOutput];
  return entry ? entry.cells : [];
});

function expandCells(fixed: readonly (0 | 1 | -1)[]): number[] {
  const cells: number[] = [];
  for (let cell = 0; cell < 1 << props.preset.variables.length; cell++) {
    let ok = true;
    for (let i = 0; i < fixed.length; i++)
      if (fixed[i] !== -1 && ((cell >> i) & 1) !== fixed[i]) {
        ok = false;
        break;
      }
    if (ok) cells.push(cell);
  }
  return cells;
}

function groupCheck(id: string) {
  return props.check.groups.find((entry) => entry.group.id === id)?.check;
}

function groupIllegal(id: string): boolean {
  return groupCheck(id)?.legal === false;
}

function toggleOutput(id: string, output: number) {
  const group = props.groups.find((entry) => entry.id === id);
  if (!group) return;
  const next = group.outputs.includes(output)
    ? group.outputs.filter((value) => value !== output)
    : [...group.outputs, output].sort((a, b) => a - b);
  if (next.length) emit("setOutputs", id, next);
}

/** cell 的位序是 canonical 变量下标；按当前显示顺序写标签。 */
function bitsLabel(cell: number): string {
  return props.order
    .map((variable, position) => {
      const label = props.variables[position];
      return `${label}=${(cell >> variable) & 1}`;
    })
    .join(" ");
}
</script>

<template>
  <div class="kmap-lab">
    <aside class="kmap-side panel">
      <div class="panel-heading"><span>卡诺图</span><small>K-MAP</small></div>
      <label class="target-label" for="kmap-preset">选择目标表</label>
      <select
        id="kmap-preset"
        :value="preset.id"
        @change="emit('choosePreset', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="item in presets" :key="item.id" :value="item.id">
          {{ item.title }} · {{ item.variables.length }} 输入 / {{ item.outputs.length }} 输出
        </option>
      </select>
      <p class="kmap-brief">{{ preset.brief }}</p>

      <div class="kmap-section-title">输出</div>
      <div class="kmap-output-tabs">
        <button
          v-for="(output, index) in preset.outputs"
          :key="output.id"
          class="kmap-output-tab"
          :class="{ active: index === activeOutput }"
          @click="emit('chooseOutput', index)"
        >
          {{ output.label }}
        </button>
      </div>

      <div class="kmap-section-title">变量顺序</div>
      <div class="kmap-order">
        <span
          v-for="(variable, index) in order"
          :key="variable"
          class="kmap-order-chip"
        >
          {{ preset.variables[variable] }}
          <small v-if="index < layerVars.length">层</small>
          <small v-else-if="index < layerVars.length + rowVars.length">行</small>
          <small v-else>列</small>
          <button
            v-if="index > 0"
            class="chip-move"
            :aria-label="`与左侧变量交换位置`"
            @click="emit('swapOrder', index - 1, index)"
          >
            ⇄
          </button>
        </span>
        <button class="text-button" @click="emit('rotateOrder')">循环移动 ↔</button>
      </div>
      <p class="small-note">
        切换顺序只改变行列摆放；圈组保存的是输入组合，不会覆盖到其它格子。
        <template v-if="layerVars.length">5–6 变量用分层网格：层内相邻、层间同位置相邻。</template>
      </p>

      <div class="kmap-section-title">圈组</div>
      <p v-if="!groups.length" class="panel-help">
        在画布上按住拖动可以圈出一块矩形。松开即生成圈组；含必须为 0 的格子会标红。
      </p>
      <ul class="kmap-group-list">
        <li
          v-for="group in groups"
          :key="group.id"
          class="kmap-group-item"
          :class="{
            selected: group.id === selectedGroup,
            illegal: groupIllegal(group.id),
            locked: group.locked,
          }"
          @click="emit('selectGroup', group.id)"
        >
          <div class="group-head">
            <b>{{ group.locked ? "锁 " : "" }}{{ group.manual ? "手动" : "方案" }}</b>
            <span>{{ expandCells(group.fixed).length }} 格</span>
          </div>
          <div class="group-outputs">
            <button
              v-for="(output, index) in preset.outputs"
              :key="output.id"
              class="output-pill"
              :class="{ on: group.outputs.includes(index) }"
              @click.stop="toggleOutput(group.id, index)"
            >
              {{ output.label }}
            </button>
          </div>
          <div class="group-actions">
            <button
              class="tiny"
              :aria-pressed="group.locked"
              @click.stop="emit('toggleLock', group.id)"
            >
              {{ group.locked ? "解锁" : "锁定" }}
            </button>
            <button class="tiny" @click.stop="emit('removeGroup', group.id)">删除</button>
          </div>
          <p v-if="groupCheck(group.id) && !groupCheck(group.id)!.legal" class="group-error">
            含 {{ groupCheck(group.id)!.zeroCells.length }} 个必须为 0 的格子
          </p>
        </li>
      </ul>
      <p class="small-note" v-if="selectedGroup">
        提示：点圈组下方的输出标签，可以把同一条圈组同时指派给多个输出，共用一根项线。
      </p>
      <div class="kmap-group-tools">
        <button :disabled="!groups.length" class="tiny" @click="emit('undo')">撤销上一圈</button>
        <button :disabled="!groups.length" class="tiny" @click="emit('clearGroups')">清空圈组</button>
      </div>
    </aside>

    <section class="kmap-center">
      <div class="board-toolbar">
        <span><b>卡诺图工作台</b><small>{{ preset.title }}</small></span>
        <span class="kmap-toolbar-note">
          拖动圈定 · 点击圈组选中 · 点锁固定
        </span>
      </div>
      <div class="kmap-board-panel">
        <KmapBoard
          :layout="layout"
          :variables="variables"
          :outputs="preset.outputs"
          :active-output="activeOutput"
          :groups="boardGroups"
          :selected-group="selectedGroup"
          :uncovered="uncoveredCells"
          @circle="emit('circle', $event)"
          @select-group="emit('selectGroup', $event)"
          @select-cell="() => {}"
        />
        <div class="kmap-legend">
          <span><i class="swatch one" />目标 1</span>
          <span><i class="swatch zero" />目标 0</span>
          <span><i class="swatch x" />无关项 ×</span>
          <span><i class="swatch covered" />已被圈组覆盖</span>
          <span><i class="swatch missing" />尚未覆盖的 1</span>
        </div>
      </div>
      <div class="kmap-insights" v-if="inspected">
        <div class="insight-block">
          <b>尚未覆盖的必须为一格子</b>
          <template v-if="check.uncoveredByOutput.every((entry) => !entry.cells.length)">
            <p class="ok">全部覆盖。</p>
          </template>
          <template v-else>
            <p v-for="entry in check.uncoveredByOutput" :key="entry.label">
              <strong>{{ entry.label }}</strong>：
              <span v-if="!entry.cells.length">无</span>
              <span v-else class="cell-tags">
                <code v-for="cell in entry.cells" :key="cell">{{ bitsLabel(cell) }}</code>
              </span>
            </p>
          </template>
        </div>
        <div class="insight-block">
          <b>误含必须为零的格子</b>
          <template v-if="!check.groups.some((entry) => entry.check.zeroCells.length)">
            <p class="ok">没有误圈。</p>
          </template>
          <p
            v-for="entry in check.groups.filter((item) => item.check.zeroCells.length)"
            :key="entry.group.id"
          >
            {{ entry.group.fixed.join("") }}：
            <span class="cell-tags">
              <code v-for="cell in entry.check.zeroCells" :key="cell">{{ bitsLabel(cell) }}</code>
            </span>
          </p>
        </div>
        <div class="insight-block">
          <b>门成本（共享项只算一次）</b>
          <p>
            与门 {{ check.cost.andGates }} · 或门 {{ check.cost.orGates }} · 非门
            {{ check.cost.notGates }} = <strong>{{ check.cost.total }}</strong> 门
          </p>
          <p v-if="check.missingOutputs.length" class="warn">
            还没有任何圈组服务：{{ check.missingOutputs.join("、") }}
          </p>
          <p v-if="check.complete" class="ok">覆盖完整，可以生成电路。</p>
          <p v-else-if="check.illegal" class="warn">
            有 {{ check.illegal }} 个标红圈组含必须为 0 的格子，生成已禁用。
          </p>
        </div>
        <div class="insight-block">
          <b>当前乘积项</b>
          <p v-for="(line, index) in expressions" :key="index" class="expression">
            {{ line }}
          </p>
        </div>
      </div>
      <div class="kmap-actions">
        <button class="primary" :disabled="solving" @click="emit('solve')">
          {{ solving ? "搜索中…" : "补齐覆盖 / 求全局最优" }}
        </button>
        <button :disabled="!groups.length" @click="emit('inspect')">检查覆盖</button>
        <button
          :disabled="!groups.length || check.illegal > 0"
          :title="check.illegal > 0 ? '先修正标红的圈组' : '逐格核对表达式和电路后再放入工作台'"
          @click="emit('generate')"
        >
          生成电路
        </button>
      </div>
      <p class="kmap-note" role="status">{{ note }}</p>
      <div v-if="build" class="kmap-build">
        <p v-if="build.error" class="inline-error">{{ build.error }}</p>
        <template v-else>
          <p class="ok">
            已生成电路：{{ build.gateCount }} 个门 · {{ build.connections }} 条连线；表达式与目标表逐格核对通过，电路仿真逐格核对通过。
          </p>
          <p v-for="(line, index) in build.expressions" :key="index" class="expression">
            {{ line }}
          </p>
        </template>
      </div>
    </section>

    <aside class="kmap-results panel">
      <div class="panel-heading"><span>求解与比较</span><small>SOLVER</small></div>
      <div v-if="unrestricted || comparison" class="compare">
        <div class="compare-card">
          <small>未锁定参考</small>
          <b>{{ unrestricted?.best ?? "—" }} 门</b>
          <span>{{ unrestricted?.proven ? "已证明最优" : unrestricted?.aborted ? "预算截断" : "—" }}</span>
        </div>
        <div class="compare-card" :class="{ worse: comparison && unrestricted && comparison.best! > unrestricted.best! }">
          <small>含锁定项</small>
          <b>{{ comparison?.best ?? "—" }} 门</b>
          <span>{{ comparison?.proven ? "已证明最优" : comparison?.aborted ? "预算截断" : "—" }}</span>
        </div>
      </div>
      <p
        v-if="comparison && unrestricted && comparison.best !== null && unrestricted.best !== null && comparison.best > unrestricted.best"
        class="inline-warn"
      >
        锁定的合法圈组让全局最优从 {{ unrestricted.best }} 门变差到 {{ comparison.best }} 门。
        两组结果都保留，锁定项仍在；不会自动解锁。
      </p>
      <div class="solutions-heading">
        同等最优方案
        <span v-if="solutions.length">
          已列出 {{ solutions.length }} 个{{ comparison?.proven ? "（已完成穷举）" : "（搜索被预算截断，可能还有其它同等最优解）" }}
        </span>
      </div>
      <div v-if="independent" class="independent-ref">
        <small>逐输出独立最少圈数（对照）</small>
        <p>
          合计 <b>{{ independent.best }}</b> 门：
          <span v-for="part in independent.parts" :key="part.label"
            >{{ part.label }} {{ part.best ?? "—" }}</span
          >
        </p>
        <p class="small-note">
          这只是“每个输出各自最少圈数”的对照；共享项可能让实际网络更便宜，所以系统并不按它求解。
        </p>
      </div>
      <p v-if="!solutions.length" class="panel-help">
        点击“补齐覆盖 / 求全局最优”，系统会把所有必须为一的格子补齐；共享乘积项按真实门成本计算。
      </p>
      <ul class="solution-list">
        <li
          v-for="solution in solutions"
          :key="solution.index"
          :class="{ active: solution.index === solutionIndex }"
          @click="emit('browse', solution.index)"
        >
          <div class="solution-head">
            <b>方案 {{ solution.index + 1 }}</b>
            <span>{{ solution.cost }} 门</span>
          </div>
          <small>
            与 {{ solution.andGates }} · 或 {{ solution.orGates }} · 非 {{ solution.notGates }}
            <em v-if="solution.locked">（含锁定）</em>
          </small>
          <p class="solution-terms">
            <code
              v-for="(term, index) in solution.terms"
              :key="index"
              :class="{ shared: term.outputs.length > 1 }"
            >{{ term.text }}<small v-if="term.outputs.length > 1">{{
                term.outputs.map((output) => preset.outputs[output]?.label).join("·")
              }}</small></code>
          </p>
        </li>
      </ul>
      <button
        class="wide"
        :disabled="!solutions.length"
        @click="emit('adopt', solutionIndex)"
      >
        把当前方案放到画布
      </button>
      <div class="lab-note">
        <b>实验手记</b>
        <p>
          逐输出最小圈数不一定最省门：同一圈组若对多个输出都合法，可以共用一根项线。
          求解器会直接以共享网络的真实门成本为最优目标。
        </p>
      </div>
    </aside>
  </div>
</template>
