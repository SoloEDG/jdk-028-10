/**
 * 卡诺图实验用的目标函数。
 *
 * 单元格编号：cell = Σ bit_i·2^i，bits 顺序与 variables 一致（variables[0] 对应 bit0）。
 * 输出值 0 / 1 / "X"（无关项）由目标表给出，学生不能修改目标表。
 */
import type { CellValue, TargetSpec } from "../lib/minimize";

export interface KmapPreset extends TargetSpec {
  id: string;
  title: string;
  brief: string;
  hint: string;
}

function table(
  n: number,
  spec: (bits: (0 | 1)[]) => CellValue | undefined,
): CellValue[] {
  const cells: CellValue[] = [];
  for (let index = 0; index < 2 ** n; index++) {
    const bits = Array.from(
      { length: n },
      (_, i) => ((index >> i) & 1) as 0 | 1,
    );
    const value = spec(bits);
    cells.push(value ?? 0);
  }
  return cells;
}

function bcd(segments: readonly number[]): CellValue[] {
  return table(4, (b) => {
    const value = b[0] * 8 + b[1] * 4 + b[2] * 2 + b[3];
    if (value > 9) return "X";
    return segments.includes(value) ? 1 : 0;
  });
}

export const presets: readonly KmapPreset[] = [
  {
    id: "wrap-ab",
    title: "环绕相邻 · AB",
    brief:
      "Y1 只需要第一行里的相邻两格；Y2 的主要圈组跨过左右边缘，必须利用列环绕。",
    hint: "最左列与最右列相邻，最上行与最下行相邻；四个角也互相相邻。",
    variables: ["A", "B", "C", "D"],
    outputs: [
      {
        id: "y1",
        label: "Y1",
        cells: table(4, (b) => (!b[0] && !b[1] ? 1 : 0)),
      },
      {
        id: "y2",
        label: "Y2",
        cells: table(4, (b) =>
          (!b[3] && !b[0]) || (!b[1] && !b[2]) ? 1 : 0,
        ),
      },
    ],
  },
  {
    id: "shared-five",
    title: "共享圈组 · 五变量",
    brief: "两个输出共用 AB 项；Y2 还需要一个含取反变量的项。",
    hint: "同一条圈组只要对两个输出都合法，就能只用一个与门驱动两路。",
    variables: ["A", "B", "C", "D", "E"],
    outputs: [
      {
        id: "y1",
        label: "Y1",
        cells: table(5, (b) => (b[0] && b[1]) || (b[2] && b[3]) ? 1 : 0),
      },
      {
        id: "y2",
        label: "Y2",
        cells: table(5, (b) => (b[0] && b[1]) || (b[2] && !b[4]) ? 1 : 0),
      },
    ],
  },
  {
    id: "priority-six",
    title: "优先编码器 · 六变量",
    brief:
      "Y1/Y2/Y3 是六个输入中第一个 1 的二进制编号（A 的优先级最高）。比它优先级低的位不会影响结果，适合用无关项。",
    hint: "第一个 1 之后的低位任意；这些格子可以当作无关项，从而把圈组做大。",
    variables: ["A", "B", "C", "D", "E", "F"],
    outputs: [
      { id: "y1", label: "Y1", cells: priority(6, 2) },
      { id: "y2", label: "Y2", cells: priority(6, 1) },
      { id: "y3", label: "Y3", cells: priority(6, 0) },
    ],
  },
  {
    id: "bcd-acd",
    title: "BCD 七段 · A/C/D 段",
    brief:
      "11 到 15 是无效 BCD 码，全部作为无关项。三个段输出可以共享圈组，共用圈组比各自最少圈数更省门。",
    hint: "共享的环比各段自己最省圈数的方案少门；无关项可以圈大块。",
    variables: ["A", "B", "C", "D"],
    outputs: [
      { id: "a", label: "段 A", cells: bcd([0, 2, 3, 5, 6, 7, 8, 9]) },
      { id: "c", label: "段 C", cells: bcd([0, 1, 3, 4, 5, 6, 8, 9]) },
      { id: "d", label: "段 D", cells: bcd([0, 2, 3, 5, 6, 8, 9]) },
    ],
  },
];

function priority(n: number, bit: number): CellValue[] {
  return table(n, (b) => {
    let highest = -1;
    for (let i = 0; i < n; i++)
      if (b[i]) {
        highest = i;
        break;
      }
    if (highest < 0) return 0;
    // A 的优先级最高，编号 000；F 最低，编号 101。
    return ((highest >> bit) & 1) as 0 | 1;
  }).map((value, cell) => {
    // 比最高有效位更低（编号更大）的位是无关项
    const b = Array.from({ length: n }, (_, i) => ((cell >> i) & 1) as 0 | 1);
    let highest = -1;
    for (let i = 0; i < n; i++)
      if (b[i]) {
        highest = i;
        break;
      }
    if (highest < 0) return value;
    for (let i = highest + 1; i < n; i++) if (b[i]) return "X";
    return value;
  });
}

export function presetById(id: string): KmapPreset {
  return presets.find((preset) => preset.id === id) ?? presets[0];
}
