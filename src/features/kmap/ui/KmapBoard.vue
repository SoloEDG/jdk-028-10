<script setup lang="ts">
/**
 * 卡诺图画布（分层）。
 *
 * 5–6 变量使用分层网格：层内 4×4，层间按层变量的格雷码排列。层内首尾
 * 相邻、跨层同位置相邻，因此任意只差一个输入位的两格都相邻。圈定只在
 * 一层内拖动；环绕方向自动取最短路径。
 *
 * 圈组按 fixed（固定的变量取值）保存，渲染时按当前变量顺序重新求格子，
 * 所以切换顺序不会覆盖错格。
 */
import { computed, ref } from "vue";
import type { CellValue } from "../lib/minimize";
import {
  axisBits,
  cellIndex,
  cubeSegments,
  rectangleRange,
  type Bit,
  type GridLayout,
} from "../lib/grid";
import type { Fixed } from "../lib/terms";

export interface BoardGroup {
  id: string;
  fixed: readonly Fixed[];
  outputs: readonly number[];
  locked: boolean;
  illegal: boolean;
}

const props = defineProps<{
  layout: GridLayout;
  variables: readonly string[];
  outputs: readonly { label: string; cells: readonly CellValue[] }[];
  activeOutput: number;
  groups: readonly BoardGroup[];
  selectedGroup: string | null;
  uncovered: readonly number[];
}>();

const emit = defineEmits<{
  circle: [cells: number[]];
  selectGroup: [id: string | null];
}>();

const CELL = 54;
const PAD = 72;
const HEADER = 46;
const LAYER_GAP = 32;
const LAYER_LABEL = 24;

const layerWidth = computed(() => PAD * 2 + props.layout.cols * CELL);
const layerHeight = computed(() => PAD + HEADER + props.layout.rows * CELL);
/** 层以 2 列排布：2 层左右并排，4 层 2×2。 */
const layerColumns = computed(() => Math.min(2, props.layout.layers));
const width = computed(
  () => layerColumns.value * layerWidth.value +
    (layerColumns.value - 1) * LAYER_GAP,
);
const height = computed(() => {
  const rows = Math.ceil(props.layout.layers / layerColumns.value);
  return rows * (layerHeight.value + LAYER_LABEL) + (rows - 1) * LAYER_GAP;
});

function layerLeft(layer: number): number {
  return (layer % layerColumns.value) * (layerWidth.value + LAYER_GAP);
}
function layerTop(layer: number): number {
  return Math.floor(layer / layerColumns.value) *
    (layerHeight.value + LAYER_LABEL + LAYER_GAP);
}

interface PositionedCell {
  cell: number;
  layer: number;
  row: number;
  col: number;
}

const cells = computed<PositionedCell[]>(() => {
  const list: PositionedCell[] = [];
  for (let layer = 0; layer < props.layout.layers; layer++)
    for (let row = 0; row < props.layout.rows; row++)
      for (let col = 0; col < props.layout.cols; col++) {
        const bits = new Array<Bit>(props.layout.n).fill(0);
        const layerBits = axisBits(props.layout.layerVars.length, layer);
        const rowBits = axisBits(props.layout.rowVars.length, row);
        const colBits = axisBits(props.layout.colVars.length, col);
        props.layout.layerVars.forEach((variable, index) => {
          bits[variable] = layerBits[index];
        });
        props.layout.rowVars.forEach((variable, index) => {
          bits[variable] = rowBits[index];
        });
        props.layout.colVars.forEach((variable, index) => {
          bits[variable] = colBits[index];
        });
        list.push({ cell: cellIndex(bits), layer, row, col });
      }
  return list;
});

function xOf(col: number): number {
  return PAD + col * CELL;
}
function yOf(layer: number, row: number): number {
  return layerTop(layer) + PAD + HEADER + row * CELL;
}

/** 轴标签：canonical 下标 + 变量名。 */
function bitsLabel(bits: readonly Bit[], variables: readonly number[]): string {
  return bits
    .map((bit, index) => `${props.variables[variables[index]]}${bit === 1 ? "" : "̅"}`)
    .join("");
}

const colLabels = computed(() =>
  Array.from({ length: props.layout.cols }, (_, col) =>
    bitsLabel(axisBits(props.layout.colVars.length, col), props.layout.colVars),
  ),
);
const rowLabels = computed(() =>
  Array.from({ length: props.layout.rows }, (_, row) =>
    bitsLabel(axisBits(props.layout.rowVars.length, row), props.layout.rowVars),
  ),
);
const layerLabels = computed(() =>
  Array.from({ length: props.layout.layers }, (_, layer) =>
    bitsLabel(axisBits(props.layout.layerVars.length, layer), props.layout.layerVars),
  ),
);

const selection = ref<{
  layer: number;
  startRow: number;
  startCol: number;
  row: number;
  col: number;
} | null>(null);
const dragging = ref(false);

const selectedCells = computed(() => {
  const active = selection.value;
  if (!active) return new Set<number>();
  const range = rectangleRange(
    props.layout,
    active.layer,
    { row: active.startRow, col: active.startCol },
    { row: active.row, col: active.col },
  );
  return new Set(range.cells);
});

const selectionRect = computed(() => {
  const active = selection.value;
  if (!active) return null;
  const range = rectangleRange(
    props.layout,
    active.layer,
    { row: active.startRow, col: active.startCol },
    { row: active.row, col: active.col },
  );
  return {
    x: layerLeft(active.layer) + xOf(range.col) + 2,
    y: yOf(active.layer, range.row) + 2,
    w: range.colSpan * CELL - 4,
    h: range.rowSpan * CELL - 4,
  };
});

function pointerDown(event: PointerEvent, entry: PositionedCell) {
  if (event.button !== 0) return;
  (event.currentTarget as SVGRectElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  selection.value = {
    layer: entry.layer,
    startRow: entry.row,
    startCol: entry.col,
    row: entry.row,
    col: entry.col,
  };
}

function pointerMove(event: PointerEvent) {
  const active = selection.value;
  if (!dragging.value || !active) return;
  const svg = (event.currentTarget as SVGSVGElement).ownerSVGElement;
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const scaleX = rect.width / (width.value || 1);
  const scaleY = rect.height / (height.value || 1);
  const x = (event.clientX - rect.left) / scaleX;
  const y = (event.clientY - rect.top) / scaleY;
  const localX = x - layerLeft(active.layer) - PAD;
  const col = Math.max(0, Math.min(props.layout.cols - 1, Math.floor(localX / CELL)));
  const local = y - layerTop(active.layer) - PAD - HEADER;
  const row = Math.max(0, Math.min(props.layout.rows - 1, Math.floor(local / CELL)));
  selection.value = { ...active, row, col };
}

function pointerUp() {
  if (!dragging.value) return;
  dragging.value = false;
  const picked = [...selectedCells.value];
  selection.value = null;
  if (picked.length) emit("circle", picked);
}

const segments = computed(() => {
  const palette = ["#df671c", "#147b87", "#7b5ea7", "#3f7d3a", "#b3477c", "#8a6d1f", "#365f9c", "#c45024"];
  return props.groups.flatMap((group, index) => {
    const color = palette[index % palette.length];
    const groupCells = expand(group.fixed);
    return cubeSegments(props.layout, groupCells).map((segment) => ({
      key: `${group.id}-${segment.layer}-${segment.row}-${segment.col}-${segment.rowSpan}-${segment.colSpan}`,
      group,
      color,
      x: layerLeft(segment.layer) + xOf(segment.col) + 4,
      y: yOf(segment.layer, segment.row) + 4,
      w: segment.colSpan * CELL - 8,
      h: segment.rowSpan * CELL - 8,
    }));
  });
});

const expandCache = computed(() => {
  const map = new Map<string, Set<number>>();
  for (const group of props.groups) {
    map.set(group.fixed.join(""), new Set(expand(group.fixed)));
  }
  return map;
});

function expand(fixed: readonly Fixed[]): number[] {
  const list: number[] = [];
  const n = props.layout.n;
  for (let cell = 0; cell < 1 << n; cell++) {
    let ok = true;
    for (let i = 0; i < n; i++)
      if (fixed[i] !== -1 && ((cell >> i) & 1) !== fixed[i]) {
        ok = false;
        break;
      }
    if (ok) list.push(cell);
  }
  return list;
}

function valueOf(cell: number, output: number): CellValue {
  return props.outputs[output]?.cells[cell] ?? 0;
}

function baseValue(cell: number): CellValue {
  return valueOf(cell, props.activeOutput);
}

function covered(cell: number): boolean {
  return props.groups.some(
    (group) =>
      group.outputs.includes(props.activeOutput) &&
      (expandCache.value.get(group.fixed.join(""))?.has(cell) ?? false),
  );
}
</script>

<template>
  <div class="kmap-board-wrap">
    <svg
      class="kmap-board"
      :viewBox="`0 0 ${width} ${height}`"
      :style="{ minWidth: `${width}px`, height: `${height}px` }"
      role="grid"
      aria-label="卡诺图，按住拖动可圈定"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointerleave="pointerUp"
    >
      <g v-for="layer in layout.layers" :key="`layer-${layer}`">
        <g v-if="layer === 0" class="kmap-wrap-guides">
          <path
            :d="`M ${layerLeft(0) + xOf(0) + 6} ${yOf(0, 0) - 22} H ${layerLeft(0) + xOf(layout.cols) - 6}`"
            class="wrap-guide"
          />
          <text :x="layerLeft(0) + xOf(0)" :y="yOf(0, 0) - 27" class="wrap-label">列首尾环绕</text>
          <path
            :d="`M ${layerLeft(0) + xOf(0) - 14} ${yOf(0, 0) + 6} V ${yOf(0, layout.rows) - 6}`"
            class="wrap-guide"
          />
          <text
            :x="layerLeft(0) + xOf(0) - 18"
            :y="yOf(0, 0) - 6"
            class="wrap-label"
            text-anchor="start"
          >
            行环绕
          </text>
        </g>
        <text :x="layerLeft(layer) + PAD" :y="layerTop(layer) + 16" class="kmap-layer-label">
          层 {{ layerLabels[layer] || "—" }}
          <tspan v-if="layout.layerVars.length" class="kmap-layer-vars">
            （{{ layout.layerVars.map((v) => variables[v]).join("、") }}）
          </tspan>
        </text>
        <text
          v-for="(label, col) in colLabels"
          :key="`c${layer}-${col}`"
          :x="layerLeft(layer) + xOf(col) + CELL / 2"
          :y="yOf(layer, 0) - 12"
          class="kmap-head"
          text-anchor="middle"
        >
          {{ label }}
        </text>
        <text
          v-for="(label, row) in rowLabels"
          :key="`r${layer}-${row}`"
          :x="layerLeft(layer) + PAD - 8"
          :y="yOf(layer, row) + CELL / 2 + 4"
          class="kmap-head"
          text-anchor="end"
        >
          {{ label }}
        </text>
      </g>
      <g v-for="entry in cells" :key="entry.cell">
        <rect
          :x="layerLeft(entry.layer) + xOf(entry.col)"
          :y="yOf(entry.layer, entry.row)"
          :width="CELL"
          :height="CELL"
          :class="[
            'kmap-cell',
            `kmap-${baseValue(entry.cell) === 'X' ? 'x' : baseValue(entry.cell)}`,
            {
              covered: covered(entry.cell),
              missing: uncovered.includes(entry.cell),
              picked: selectedCells.has(entry.cell),
            },
          ]"
          @pointerdown="pointerDown($event, entry)"
        />
        <text
          :x="layerLeft(entry.layer) + xOf(entry.col) + CELL / 2"
          :y="yOf(entry.layer, entry.row) + CELL / 2 + 1"
          class="kmap-value"
          :class="`kmap-value-${baseValue(entry.cell) === 'X' ? 'x' : baseValue(entry.cell)}`"
          text-anchor="middle"
          dominant-baseline="middle"
          pointer-events="none"
        >
          {{ baseValue(entry.cell) === "X" ? "×" : baseValue(entry.cell) }}
        </text>
        <text
          :x="layerLeft(entry.layer) + xOf(entry.col) + 4"
          :y="yOf(entry.layer, entry.row) + 12"
          class="kmap-index"
          pointer-events="none"
        >
          {{ entry.cell }}
        </text>
        <text
          v-if="outputs.length > 1"
          :x="layerLeft(entry.layer) + xOf(entry.col) + CELL - 4"
          :y="yOf(entry.layer, entry.row) + 12"
          class="kmap-mini"
          :class="{
            active: props.activeOutput === 0,
            zero: valueOf(entry.cell, props.activeOutput) === 0,
          }"
          text-anchor="end"
          pointer-events="none"
        >
          {{ valueOf(entry.cell, props.activeOutput) === "X" ? "×" : valueOf(entry.cell, props.activeOutput) }}
        </text>
      </g>
      <rect
        v-if="selectionRect"
        :x="selectionRect.x"
        :y="selectionRect.y"
        :width="selectionRect.w"
        :height="selectionRect.h"
        class="kmap-selection"
        rx="10"
        pointer-events="none"
      />
      <g
        v-for="segment in segments"
        :key="segment.key"
        class="kmap-group"
        :class="{
          selected: segment.group.id === selectedGroup,
          illegal: segment.group.illegal,
        }"
      >
        <rect
          :x="segment.x"
          :y="segment.y"
          :width="segment.w"
          :height="segment.h"
          rx="12"
          :stroke="segment.color"
          fill="none"
          :stroke-width="segment.group.id === selectedGroup ? 3.4 : 2.2"
          :stroke-dasharray="segment.group.locked ? undefined : '7 4'"
          pointer-events="none"
        />
        <text
          v-if="segment.group.locked"
          :x="segment.x + segment.w - 7"
          :y="segment.y + 14"
          class="kmap-lock"
          text-anchor="end"
          pointer-events="none"
        >
          锁
        </text>
        <rect
          :x="segment.x"
          :y="segment.y"
          :width="segment.w"
          :height="segment.h"
          rx="12"
          fill="none"
          class="kmap-group-hit"
          @click.stop="emit('selectGroup', segment.group.id)"
        />
      </g>
    </svg>
  </div>
</template>
