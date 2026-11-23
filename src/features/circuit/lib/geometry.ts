import type { GateNode, Point } from "@/shared/types";
import { getSpec } from "@/features/catalog/lib/specs";
export const BOARD = {
  width: 1000,
  height: 520,
  nodeWidth: 112,
  nodeHeight: 86,
};
export function snapPosition(point: Point): Point {
  return {
    x: Math.round(Math.max(24, Math.min(864, point.x)) / 20) * 20,
    y: Math.round(Math.max(48, Math.min(412, point.y)) / 20) * 20,
  };
}
export function portPoint(
  node: GateNode,
  direction: "input" | "output",
  port = 0,
): Point {
  const count =
    direction === "input"
      ? getSpec(node.kind).inputs
      : getSpec(node.kind).outputs;
  return {
    x: node.x + (direction === "output" ? BOARD.nodeWidth : 0),
    y: node.y + (BOARD.nodeHeight * (port + 1)) / (count + 1),
  };
}
export function wirePath(from: Point, to: Point): string {
  const bend = Math.max(42, Math.abs(to.x - from.x) * 0.46);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/**
 * 由元件位置计算画布大小：生成的电路可能远超默认 1000×520。
 * 至少保留默认尺寸，四周留出 120px 边距。
 */
export function boardBounds(nodes: readonly GateNode[]): { width: number; height: number } {
  let width = BOARD.width;
  let height = BOARD.height;
  for (const node of nodes) {
    width = Math.max(width, node.x + BOARD.nodeWidth + 120);
    height = Math.max(height, node.y + BOARD.nodeHeight + 120);
  }
  return { width, height };
}
