/**
 * 卡诺图网格布局（最多 6 变量，分层表示）。
 *
 *  - 1–4 变量：单层网格，行 / 列各占 1–2 个变量。
 *  - 5 变量：2 层（层变量 1 个），每层 4×4。
 *  - 6 变量：4 层（层变量 2 个），每层 4×4。
 *
 * 层内行列都用反射格雷码，首尾相邻；层之间按层变量的格雷码排列，
 * 只差一个层变量的两层格子位置相同、互相相邻。因此任意一对只差一个
 * 输入位的格子都相邻：要么层内相邻（含环绕），要么跨层同位。
 *
 * 单元格编号始终是 cell = Σ bit_i·2^i（i 为 canonical 变量下标），
 * 与显示顺序无关。变量顺序只决定哪些变量分到行、列、层。
 */

export type Bit = 0 | 1;
export type CellValue = 0 | 1 | "X";

export interface GridLayout {
  n: number;
  /** 层变量在 variables 中的下标。 */
  layerVars: number[];
  rowVars: number[];
  colVars: number[];
  rows: number;
  cols: number;
  layers: number;
}

export function graySequence(count: number): number[] {
  return Array.from({ length: 2 ** count }, (_, i) => i ^ (i >> 1));
}

export function layoutFor(n: number, order: readonly number[] = []): GridLayout {
  if (n < 1 || n > 6) throw new Error("卡诺图支持 1 到 6 个变量");
  const sequence =
    order.length === n && new Set(order).size === n
      ? [...order]
      : Array.from({ length: n }, (_, i) => i);
  const layerCount = n <= 4 ? 0 : n === 5 ? 1 : 2;
  const layerVars = sequence.slice(0, layerCount);
  const gridVars = sequence.slice(layerCount);
  const rowCount = gridVars.length >= 4 ? 2 : Math.max(0, gridVars.length - 2);
  const rowVars = gridVars.slice(0, rowCount);
  const colVars = gridVars.slice(rowCount);
  return {
    n,
    layerVars,
    rowVars,
    colVars,
    rows: 2 ** rowVars.length,
    cols: 2 ** colVars.length,
    layers: 2 ** layerVars.length,
  };
}

/** 某一轴的索引 → 变量取值（前面是高位，反射格雷码）。 */
export function axisBits(count: number, index: number): Bit[] {
  if (count === 0) return [];
  const value = graySequence(count)[index] ?? 0;
  return Array.from(
    { length: count },
    (_, k) => ((value >> (count - 1 - k)) & 1) as Bit,
  );
}

export interface GridCell {
  cell: number;
  layer: number;
  row: number;
  col: number;
  bits: Bit[];
}

export function bitsAt(
  layout: GridLayout,
  layer: number,
  row: number,
  col: number,
): Bit[] {
  const bits = new Array<Bit>(layout.n).fill(0);
  const layerBits = axisBits(layout.layerVars.length, layer);
  const rowBits = axisBits(layout.rowVars.length, row);
  const colBits = axisBits(layout.colVars.length, col);
  layout.layerVars.forEach((variable, k) => {
    bits[variable] = layerBits[k];
  });
  layout.rowVars.forEach((variable, k) => {
    bits[variable] = rowBits[k];
  });
  layout.colVars.forEach((variable, k) => {
    bits[variable] = colBits[k];
  });
  return bits;
}

export function cellIndex(bits: readonly Bit[]): number {
  let cell = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) cell |= 1 << i;
  return cell;
}

export function gridCells(layout: GridLayout): GridCell[] {
  const cells: GridCell[] = [];
  for (let layer = 0; layer < layout.layers; layer++)
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        const bits = bitsAt(layout, layer, row, col);
        cells.push({ cell: cellIndex(bits), layer, row, col, bits });
      }
  return cells;
}

export function positionMap(
  layout: GridLayout,
): Map<number, { layer: number; row: number; col: number }> {
  return new Map(
    gridCells(layout).map((entry) => [
      entry.cell,
      { layer: entry.layer, row: entry.row, col: entry.col },
    ]),
  );
}

function contiguousRuns(indices: readonly number[]): { start: number; length: number }[] {
  if (!indices.length) return [];
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: { start: number; length: number }[] = [];
  let start = sorted[0];
  let length = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) length++;
    else {
      runs.push({ start, length });
      start = sorted[i];
      length = 1;
    }
  }
  runs.push({ start, length });
  return runs;
}

function cyclicRanges(
  indices: readonly number[],
  size: number,
): { start: number; length: number }[] {
  const runs = contiguousRuns(indices);
  if (
    runs.length > 1 &&
    runs[0].start === 0 &&
    runs[runs.length - 1].start + runs[runs.length - 1].length === size
  ) {
    const head = runs.shift()!;
    const tail = runs.pop()!;
    runs.push({ start: tail.start - size, length: tail.length + head.length });
  }
  return runs;
}

function segmentCells(
  layout: GridLayout,
  layer: number,
  rowRange: { start: number; length: number },
  colRange: { start: number; length: number },
): number[] {
  const cells: number[] = [];
  for (let dr = 0; dr < rowRange.length; dr++)
    for (let dc = 0; dc < colRange.length; dc++) {
      const row = (rowRange.start + dr + layout.rows) % layout.rows;
      const col = (colRange.start + dc + layout.cols) % layout.cols;
      cells.push(cellIndex(bitsAt(layout, layer, row, col)));
    }
  return cells;
}

export interface RectSegment {
  layer: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/**
 * 一个乘积项在画布上的矩形段：逐层取恰好覆盖该层目标格子的矩形，
 * 层内允许环绕成 2–4 段。
 */
export function cubeSegments(
  layout: GridLayout,
  cells: readonly number[],
): RectSegment[] {
  const positions = positionMap(layout);
  const target = new Set(cells);
  const byLayer = new Map<number, number[]>();
  for (const cell of cells) {
    const position = positions.get(cell);
    if (!position) continue;
    const list = byLayer.get(position.layer) ?? [];
    list.push(cell);
    byLayer.set(position.layer, list);
  }
  const segments: RectSegment[] = [];
  let complete = byLayer.size > 0;
  for (const [layer, layerCells] of byLayer) {
    if (!complete) break;
    const rows = [...new Set(layerCells.map((cell) => positions.get(cell)!.row))];
    const cols = [...new Set(layerCells.map((cell) => positions.get(cell)!.col))];
    const rowRanges = cyclicRanges(rows, layout.rows);
    const colRanges = cyclicRanges(cols, layout.cols);
    const totalRows = rowRanges.reduce((sum, range) => sum + range.length, 0);
    const totalCols = colRanges.reduce((sum, range) => sum + range.length, 0);
    if (totalRows * totalCols !== layerCells.length) {
      complete = false;
      break;
    }
    const produced = new Set<number>();
    const layerSegments: RectSegment[] = [];
    for (const rowRange of rowRanges)
      for (const colRange of colRanges) {
        layerSegments.push({
          layer,
          row: rowRange.start,
          col: colRange.start,
          rowSpan: rowRange.length,
          colSpan: colRange.length,
        });
        for (const cell of segmentCells(layout, layer, rowRange, colRange))
          produced.add(cell);
      }
    if (produced.size !== layerCells.length) {
      complete = false;
      break;
    }
    for (const cell of produced)
      if (!target.has(cell) || !layerCells.includes(cell)) {
        complete = false;
        break;
      }
    if (!complete) break;
    segments.push(...layerSegments);
  }
  if (complete && segments.length) return segments;
  // 兜底：逐格显示（调用方通常已阻止非乘积项）
  return cells.map((cell) => {
    const position = positions.get(cell)!;
    return {
      layer: position.layer,
      row: position.row,
      col: position.col,
      rowSpan: 1,
      colSpan: 1,
    };
  });
}

function cyclicSpan(
  size: number,
  a: number,
  b: number,
): { start: number; length: number } {
  const forward = (b - a + size) % size;
  const backward = (a - b + size) % size;
  if (forward <= backward) return { start: a, length: forward + 1 };
  return { start: b, length: backward + 1 };
}

/** 同层两个格子的（允许环绕的）矩形范围，用于拖动圈定。 */
export function rectangleRange(
  layout: GridLayout,
  layer: number,
  a: { row: number; col: number },
  b: { row: number; col: number },
): { row: number; col: number; rowSpan: number; colSpan: number; cells: number[] } {
  const rowSpan = cyclicSpan(layout.rows, a.row, b.row);
  const colSpan = cyclicSpan(layout.cols, a.col, b.col);
  const cells: number[] = [];
  for (let dr = 0; dr < rowSpan.length; dr++)
    for (let dc = 0; dc < colSpan.length; dc++) {
      const row = (rowSpan.start + dr + layout.rows) % layout.rows;
      const col = (colSpan.start + dc + layout.cols) % layout.cols;
      cells.push(cellIndex(bitsAt(layout, layer, row, col)));
    }
  return {
    row: rowSpan.start,
    col: colSpan.start,
    rowSpan: rowSpan.length,
    colSpan: colSpan.length,
    cells,
  };
}
