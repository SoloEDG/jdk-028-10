/**
 * 圈组（乘积项）的表示、合法性检查与门成本。
 * 圈组只保存“固定变量取值”（0 / 1 / 不关心），与网格位置无关。
 */
import type { CellValue } from "./minimize";

export type Bit = 0 | 1;
export type Fixed = Bit | -1;

export interface GroupTerm {
  /** fixed[i] 为 -1 表示变量 i 不在项中。 */
  fixed: readonly Fixed[];
  /** 该圈组服务的输出下标（升序）。 */
  outputs: readonly number[];
}

export interface OutputTable {
  label: string;
  cells: readonly CellValue[];
}

export interface GroupCheck {
  legal: boolean;
  /** 圈住的必须为一、但尚未被本输出任何圈组覆盖的格子。 */
  uncoveredOnes: number[];
  /** 圈住的必须为零格子（错误）。 */
  zeroCells: number[];
  /** 圈住的全是无关项：合法但无用。 */
  wildcardsOnly: boolean;
  /** 圈住的无关项数量。 */
  wildcardCells: number[];
  /** 该输出下这个圈组覆盖到的为一格子。 */
  coveredOnes: number[];
}

export function termCells(fixed: readonly Fixed[], n: number): number[] {
  const cells: number[] = [];
  const total = 1 << n;
  for (let cell = 0; cell < total; cell++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (fixed[i] !== -1 && ((cell >> i) & 1) !== fixed[i]) {
        ok = false;
        break;
      }
    }
    if (ok) cells.push(cell);
  }
  return cells;
}

export function termKey(fixed: readonly Fixed[]): string {
  return fixed.map((value) => (value === -1 ? "-" : String(value))).join("");
}

export function parseTermKey(key: string): Fixed[] {
  return [...key].map((char) => (char === "-" ? -1 : (Number(char) as Bit)));
}

export function sameTerm(a: readonly Fixed[], b: readonly Fixed[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function termCost(fixed: readonly Fixed[]): number {
  const literals = fixed.filter((value) => value !== -1).length;
  return Math.max(0, literals - 1);
}

export function termText(fixed: readonly Fixed[], variables: readonly string[]): string {
  const parts: string[] = [];
  fixed.forEach((value, i) => {
    if (value === -1) return;
    parts.push(`${variables[i]}${value === 0 ? "̅" : ""}`);
  });
  return parts.length ? parts.join("·") : "1";
}

export function checkGroup(
  fixed: readonly Fixed[],
  outputs: readonly number[],
  tables: readonly OutputTable[],
  coveredByOutput: readonly Set<number>[] = [],
): GroupCheck {
  const n = fixed.length;
  const cells = termCells(fixed, n);
  const zeroCells: number[] = [];
  const wildcardCells: number[] = [];
  const uncoveredOnes: number[] = [];
  const coveredOnes: number[] = [];
  for (const output of outputs) {
    const table = tables[output];
    if (!table) continue;
    for (const cell of cells) {
      const value = table.cells[cell];
      if (value === 0) zeroCells.push(cell);
      else if (value === "X") wildcardCells.push(cell);
      else {
        coveredOnes.push(cell);
        if (!coveredByOutput[output]?.has(cell)) uncoveredOnes.push(cell);
      }
    }
  }
  const uniqueZeros = [...new Set(zeroCells)];
  const uniqueWild = [...new Set(wildcardCells)];
  return {
    legal: uniqueZeros.length === 0,
    uncoveredOnes: [...new Set(uncoveredOnes)],
    zeroCells: uniqueZeros,
    wildcardsOnly: outputs.length > 0 && uniqueWild.length === cells.length * outputs.length,
    wildcardCells: uniqueWild,
    coveredOnes: [...new Set(coveredOnes)],
  };
}

/** 圈住的整个卡诺图（没有任何固定变量）不是可用的乘积项。 */
export function isTautology(fixed: readonly Fixed[]): boolean {
  return fixed.every((value) => value === -1);
}

/**
 * 一次圈组选择是否是一个合法乘积项：单元格集合必须是某个“固定变量模式”
 * 的全部单元格（即网格上的矩形，允许环绕）。
 */
export function cellsToTerm(cells: readonly number[], n: number): Fixed[] | null {
  if (!cells.length) return null;
  const set = new Set(cells);
  const fixed: Fixed[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let zeros = 0;
    let ones = 0;
    for (const cell of set) {
      if ((cell >> i) & 1) ones++;
      else zeros++;
    }
    if (zeros && ones) fixed[i] = -1;
    else if (ones) fixed[i] = 1;
    else fixed[i] = 0;
  }
  // 必须恰好是完整子立方体，不能缺角。
  const total = 1 << n;
  let count = 0;
  for (let cell = 0; cell < total; cell++) {
    let ok = true;
    for (let i = 0; i < n; i++)
      if (fixed[i] !== -1 && ((cell >> i) & 1) !== fixed[i]) {
        ok = false;
        break;
      }
    if (ok) count++;
  }
  return count === set.size ? fixed : null;
}

/** 全 1 目标（所有格子都必须为 1）时，唯一有效乘积项是常量 1。 */
export function fullCoverTerm(n: number): Fixed[] {
  return new Array<Fixed>(n).fill(-1);
}
