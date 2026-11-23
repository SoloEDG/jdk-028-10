/**
 * 多输出二级逻辑最小化。
 *
 * 与逐输出最小化的区别：一个乘积项（圈组）只要对多个输出都合法，就只需要
 * 一个与门 / 一根项线，然后扇出到多个输出的或网络。这里的目标函数直接计算
 * 这种共享网络的门成本，因此会主动寻找共享项，而不是先分别最小化每个输出。
 *
 * 成本口径（二输入门，两项最便宜的与/或树）：
 *  - 乘积项有 L 个字面量：max(0, L-1) 个与门（单字面量直接连线）
 *  - 每个输出有 T 个乘积项：max(0, T-1) 个或门
 *  - 所有项中出现的取反变量：每个变量只建一个非门
 */
export type Bit = 0 | 1;
export type CellValue = 0 | 1 | "X";
export interface Cube {
  fixed: readonly (Bit | -1)[];
  lit: number;
  mask: bigint;
  negMask: number;
}
export interface TargetOutput {
  id: string;
  label: string;
  cells: readonly CellValue[];
  [extra: string]: unknown;
}
export interface TargetSpec {
  variables: readonly string[];
  outputs: readonly TargetOutput[];
}
export interface TermAssignment {
  fixed: readonly (Bit | -1)[];
  outputs: readonly number[];
}
export interface CostBreakdown {
  andGates: number;
  orGates: number;
  notGates: number;
  total: number;
}
export interface Solution {
  cost: number;
  terms: TermAssignment[];
  breakdown: CostBreakdown;
}
export interface SolveOptions {
  /** 学生锁定、必须保留在结果里的圈组（含所属输出）。 */
  locked?: readonly TermAssignment[];
  budget?: number;
  timeMs?: number;
  want?: number;
  /** 已收集的方案：继续找其它同等最优解时跳过它们。 */
  exclude?: readonly TermAssignment[][];
}
export interface SolveResult {
  best: number | null;
  solutions: Solution[];
  proven: boolean;
  aborted: boolean;
  nodes: number;
  candidates: number;
  elapsedMs: number;
  lowerBound: number;
}
function pcInt(x: number): number { let c = 0; while (x) { x &= x - 1; c++; } return c; }
function pcBig(x: bigint): number { let c = 0; while (x) { x &= x - 1n; c++; } return c; }
/**
 * 单元格编号约定：cell = Σ bit_i · 2^i，变量下标 i 从 0 开始，
 * 与 enumerateCubes / 求解器内部的位序完全一致。
 */
export function cellIndex(bits: readonly Bit[]): number {
  let cell = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) cell |= 1 << i;
  return cell;
}
export function cubeMask(fixed: readonly (Bit | -1)[], n: number): bigint {
  let mask = 0n;
  const N = 1 << n;
  for (let q = 0; q < N; q++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      const f = fixed[i];
      if (f !== -1 && ((q >> i) & 1) !== f) { ok = false; break; }
    }
    if (ok) mask |= 1n << BigInt(q);
  }
  return mask;
}
export function cubeNegMask(fixed: readonly (Bit | -1)[]): number {
  let mask = 0;
  for (let i = 0; i < fixed.length; i++) if (fixed[i] === 0) mask |= 1 << i;
  return mask;
}
function enumerateCubes(n: number): Cube[] {
  const cubes: Cube[] = [];
  const total = 3 ** n;
  for (let code = 0; code < total; code++) {
    let x = code;
    const fixed = new Array<Bit | -1>(n);
    let lit = 0;
    let bits = 0;
    for (let i = 0; i < n; i++) {
      const s = (x % 3) - 1;
      x = (x / 3) | 0;
      fixed[i] = s as Bit | -1;
      if (s !== -1) { lit++; if (s === 1) bits |= 1 << i; }
    }
    const free: number[] = [];
    for (let i = 0; i < n; i++) if (fixed[i] === -1) free.push(i);
    let mask = 0n;
    const combos = 1 << free.length;
    for (let sub = 0; sub < combos; sub++) {
      let idx = bits;
      for (let k = 0; k < free.length; k++) if ((sub >> k) & 1) idx |= 1 << free[k];
      mask |= 1n << BigInt(idx);
    }
    cubes.push({ fixed, lit, mask, negMask: cubeNegMask(fixed) });
  }
  return cubes;
}
export interface Prepared {
  n: number;
  m: number;
  ones: bigint[];
  allowed: bigint[];
  zeros: bigint[];
  candidates: Cube[];
  byCell: Cube[][][];
}
function prepare(n: number, target: readonly TargetOutput[], extra: readonly Cube[] = []): Prepared {
  const N = 1 << n;
  const m = target.length;
  const ones = target.map(() => 0n);
  const allowed = target.map(() => 0n);
  const zeros = target.map(() => 0n);
  for (let o = 0; o < m; o++) {
    const cells = target[o].cells;
    for (let q = 0; q < N; q++) {
      const v = cells[q];
      if (v === 1) { ones[o] |= 1n << BigInt(q); allowed[o] |= 1n << BigInt(q); }
      else if (v === "X") allowed[o] |= 1n << BigInt(q);
      else zeros[o] |= 1n << BigInt(q);
    }
  }
  const allCubes = enumerateCubes(n);
  const candidateMap = new Map<string, Cube>();
  for (let S = 1; S < 1 << m; S++) {
    let allowedSet: bigint | null = null;
    const onesList: bigint[] = [];
    for (let o = 0; o < m; o++) if (S & (1 << o)) {
      allowedSet = allowedSet === null ? allowed[o] : allowedSet & allowed[o];
      onesList.push(ones[o]);
    }
    if (allowedSet === null || allowedSet === 0n) continue;
    const list: Cube[] = [];
    for (const c of allCubes) {
      if ((c.mask & ~allowedSet) !== 0n) continue;
      let ok = true;
      for (const o of onesList) if ((c.mask & o) === 0n) { ok = false; break; }
      if (ok) list.push(c);
    }
    for (const c of list) {
      let prime = true;
      for (const d of list) {
        if (d === c) continue;
        if (d.lit < c.lit && (d.mask & c.mask) === c.mask) { prime = false; break; }
      }
      if (!prime) continue;
      let valid = 0;
      for (let o = 0; o < m; o++) if ((c.mask & zeros[o]) === 0n && (c.mask & ones[o]) !== 0n) valid |= 1 << o;
      const key = c.mask.toString() + "|" + valid;
      const prior = candidateMap.get(key);
      if (!prior || c.negMask < prior.negMask) candidateMap.set(key, c);
    }
  }
  for (const c of extra) {
    let valid = 0;
    for (let o = 0; o < m; o++) if ((c.mask & zeros[o]) === 0n && (c.mask & ones[o]) !== 0n) valid |= 1 << o;
    if (valid === 0) continue;
    const key = c.mask.toString() + "|" + valid;
    if (!candidateMap.has(key)) candidateMap.set(key, c);
  }
  const candidates = [...candidateMap.values()];
  const byCell: Cube[][][] = Array.from({ length: m }, () => Array.from({ length: N }, () => [] as Cube[]));
  for (const c of candidates) for (let o = 0; o < m; o++)
    if ((c.mask & zeros[o]) === 0n && (c.mask & ones[o]) !== 0n) {
    let mm = c.mask & ones[o];
    while (mm) {
      const bit = mm & -mm;
      const idx = bit.toString(2).length - 1;
      byCell[o][idx].push(c);
      mm ^= bit;
    }
  }
  return { n, m, ones, allowed, zeros, candidates, byCell };
}
interface SearchTerm { cube: Cube; outputs: number[]; }
interface RawSolution { cost: number; terms: SearchTerm[]; sig: string; }
/** 展开一个乘积项覆盖的全部 cell（与位序约定一致）。 */
export function termCellList(fixed: readonly (Bit | -1)[], n: number): number[] {
  const cells: number[] = [];
  for (let cell = 0; cell < 1 << n; cell++) {
    let ok = true;
    for (let i = 0; i < n; i++)
      if (fixed[i] !== -1 && ((cell >> i) & 1) !== fixed[i]) {
        ok = false;
        break;
      }
    if (ok) cells.push(cell);
  }
  return cells;
}

export function solutionKey(terms: readonly TermAssignment[]): string {
  return terms
    .map((term) => `${term.fixed.join("")}:${[...term.outputs].sort((a, b) => a - b).join("")}`)
    .sort()
    .join("|");
}
function signatureOf(terms: readonly SearchTerm[]): string {
  const map = new Map<bigint, number>();
  for (const t of terms) map.set(t.cube.mask, (map.get(t.cube.mask) ?? 0) | t.outputs.reduce((a, o) => a | (1 << o), 0));
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([mask, outs]) => `${mask.toString(36)}:${outs}`)
    .join(",");
}
function costOf(map: ReadonlyMap<bigint, Cube>, assign: ReadonlyMap<bigint, number>, invMask: number, m: number): CostBreakdown {
  let andGates = 0;
  const terms = new Array<number>(m).fill(0);
  for (const [mask, cube] of map) {
    andGates += Math.max(0, cube.lit - 1);
    const outs = assign.get(mask) ?? 0;
    for (let o = 0; o < m; o++) if (outs & (1 << o)) terms[o]++;
  }
  let orGates = 0;
  for (let o = 0; o < m; o++) orGates += Math.max(0, terms[o] - 1);
  const notGates = pcInt(invMask);
  return { andGates, orGates, notGates, total: andGates + orGates + notGates };
}
export function solve(target: TargetSpec, options: SolveOptions = {}): SolveResult {
  const started = Date.now();
  const n = target.variables.length;
  const m = target.outputs.length;
  const budget = options.budget ?? 250_000;
  const timeMs = options.timeMs ?? 1500;
  const want = options.want ?? 6;
  const locked = options.locked ?? [];
  const lockedCubes: Cube[] = locked.map((t) => ({
    fixed: t.fixed,
    lit: t.fixed.reduce<number>((a, v) => a + (v === -1 ? 0 : 1), 0),
    mask: cubeMask(t.fixed, n),
    negMask: cubeNegMask(t.fixed),
  }));
  const P = prepare(n, target.outputs, lockedCubes);
  const { ones, byCell } = P;

  let nodes = 0;
  let aborted = false;
  const used = new Map<bigint, Cube>();
  const assign = new Map<bigint, number>();
  const covers = new Array<bigint>(m).fill(0n);
  const terms = new Array<number>(m).fill(0);
  let invMask = 0;
  let cost = 0;
  interface Step {
    cube: Cube; output: number; prevCovers: bigint; prevUsed: boolean;
    prevAssign: number; prevInv: number; prevTerms: number; prevCost: number;
  }
  const trail: Step[] = [];
  function applyCube(c: Cube, o: number): void {
    const prevAssign = assign.get(c.mask) ?? 0;
    const prevUsed = used.has(c.mask);
    trail.push({ cube: c, output: o, prevCovers: covers[o], prevUsed, prevAssign, prevInv: invMask, prevTerms: terms[o], prevCost: cost });
    if (!prevUsed) {
      used.set(c.mask, c);
      cost += Math.max(0, c.lit - 1);
      const freshInv = c.negMask & ~invMask;
      cost += pcInt(freshInv);
      invMask |= c.negMask;
    }
    if (terms[o] > 0) cost += 1;
    terms[o]++;
    covers[o] |= c.mask;
    assign.set(c.mask, prevAssign | (1 << o));
  }
  function undo(): void {
    const t = trail.pop();
    if (!t) return;
    covers[t.output] = t.prevCovers;
    terms[t.output] = t.prevTerms;
    invMask = t.prevInv;
    cost = t.prevCost;
    if (t.prevAssign) assign.set(t.cube.mask, t.prevAssign); else assign.delete(t.cube.mask);
    if (!t.prevUsed) used.delete(t.cube.mask);
  }
  locked.forEach((assignment, index) => {
    const c = lockedCubes[index];
    for (const o of assignment.outputs) applyCube(c, o);
  });
  function currentCost(): number { return cost; }
  const baseTrail = trail.length;
  function resetToBase(): void { while (trail.length > baseTrail) undo(); }
  function remainingOutputs(): boolean {
    for (let o = 0; o < m; o++) if (ones[o] & ~covers[o]) return true;
    return false;
  }
  function chooseCell(): { output: number; cell: number; moves: Cube[] } | null {
    let pick: { output: number; cell: number; moves: Cube[] } | null = null;
    for (let o = 0; o < m; o++) {
      let rem = ones[o] & ~covers[o];
      while (rem) {
        const bit = rem & -rem;
        const cell = bit.toString(2).length - 1;
        rem ^= bit;
        const moves = byCell[o][cell].filter((c) => !((assign.get(c.mask) ?? 0) & (1 << o)));
        if (!pick || moves.length < pick.moves.length) {
          pick = { output: o, cell, moves };
          if (moves.length === 1) return pick;
        }
      }
    }
    return pick;
  }
  function lowerBound(): number {
    let orLB = 0;
    let andLB = 0;
    for (let o = 0; o < m; o++) {
      let rem = ones[o] & ~covers[o];
      if (!rem) continue;
      let k = 0;
      let andMin = 0;
      while (rem) {
        k++;
        const bit = rem & -rem;
        const cell = bit.toString(2).length - 1;
        let cov = 0n;
        let bestAnd = Infinity;
        for (const c of byCell[o][cell]) {
          cov |= c.mask;
          const a = used.has(c.mask) ? 0 : Math.max(0, c.lit - 1);
          if (a < bestAnd) bestAnd = a;
        }
        andMin += bestAnd;
        rem &= ~cov;
      }
      let terms = 0;
      for (const outs of assign.values()) if (outs & (1 << o)) terms++;
      orLB += terms > 0 ? k : Math.max(0, k - 1);
      if (andMin > andLB) andLB = andMin;
    }
    return orLB + andLB;
  }
  function collectTerms(): SearchTerm[] {
    const list: SearchTerm[] = [];
    for (const [mask, cube] of used) {
      const outs = assign.get(mask) ?? 0;
      if (!outs) continue;
      list.push({ cube, outputs: [...Array(m).keys()].filter((o) => outs & (1 << o)) });
    }
    return list;
  }
  // greedy for a quick incumbent
  function greedy(): number | null {
    while (true) {
      const base = currentCost();
      let bestMove: { c: Cube; o: number } | null = null;
      let bestScore = -Infinity;
      for (let o = 0; o < m; o++) {
        let rem = ones[o] & ~covers[o];
        while (rem) {
          const bit = rem & -rem;
          const cell = bit.toString(2).length - 1;
          rem ^= bit;
          for (const c of byCell[o][cell]) {
            if ((assign.get(c.mask) ?? 0) & (1 << o)) continue;
            const newly = pcBig(ones[o] & c.mask & ~covers[o]);
            applyCube(c, o);
            const delta = currentCost() - base;
            undo();
            const score = newly / Math.max(0.5, delta + 0.1);
            if (score > bestScore) { bestScore = score; bestMove = { c, o }; }
          }
        }
      }
      if (!bestMove) break;
      applyCube(bestMove.c, bestMove.o);
    }
    if (remainingOutputs()) { resetToBase(); return null; }
    return currentCost();
  }
  const banned = new Set<string>((options.exclude ?? []).map((terms) => solutionKey(terms)));
  const greedyCost = greedy();
  let searchBest = greedyCost === null ? Infinity : greedyCost;
  let foundSols: RawSolution[] = [];
  resetToBase();
  const targetSigs = new Set<string>();
  const deadline = started + timeMs;
  const solutionBudget = want;
  function rec(): void {
    nodes++;
    if (nodes > budget || Date.now() > deadline) { aborted = true; return; }
    const cost = currentCost();
    if (cost > searchBest) return;
    if (!remainingOutputs()) {
      if (cost < searchBest) {
        searchBest = cost;
        foundSols = [];
        targetSigs.clear();
      }
      if (cost === searchBest && foundSols.length < solutionBudget) {
        const list = collectTerms();
        const sig = signatureOf(list);
        const plain = list.map((t) => ({ fixed: t.cube.fixed, outputs: t.outputs }));
        if (!targetSigs.has(sig) && !banned.has(solutionKey(plain))) {
          foundSols.push({ cost, terms: list, sig });
          targetSigs.add(sig);
        }
      }
      return;
    }
    if (cost + lowerBound() > searchBest) return;
    const pick = chooseCell();
    if (!pick) return;
    const score = (c: Cube): number => pcBig(ones[pick.output] & c.mask & ~covers[pick.output]);
    const moves = [...pick.moves].sort((a, b) => score(b) - score(a) || a.lit - b.lit);
    const mark = trail.length;
    for (const c of moves) {
      applyCube(c, pick.output);
      rec();
      while (trail.length > mark) undo();
      if (aborted) return;
    }
  }
  rec();
  const toSolution = (raw: RawSolution): Solution => {
    const map = new Map<bigint, Cube>();
    const outs = new Map<bigint, number>();
    for (const t of raw.terms) {
      map.set(t.cube.mask, t.cube);
      outs.set(t.cube.mask, t.outputs.reduce((a, o) => a | (1 << o), 0));
    }
    let inv = 0;
    for (const t of raw.terms) inv |= t.cube.negMask;
    return {
      cost: raw.cost,
      breakdown: costOf(map, outs, inv, m),
      terms: raw.terms.map((t) => ({ fixed: t.cube.fixed, outputs: t.outputs })),
    };
  };
  const solutions = foundSols
    .sort((a, b) => a.sig.localeCompare(b.sig))
    .map(toSolution);
  let lb = 0;
  for (let o = 0; o < m; o++) {
    let rem = ones[o];
    let k = 0;
    while (rem) {
      k++;
      const bit = rem & -rem;
      const cell = bit.toString(2).length - 1;
      let cov = 0n;
      for (const c of byCell[o][cell]) cov |= c.mask;
      if (cov === 0n) break;
      rem &= ~cov;
    }
    lb += Math.max(0, k - 1);
  }
  return {
    best: searchBest === Infinity ? null : searchBest,
    solutions,
    proven: !aborted && searchBest !== Infinity,
    aborted,
    nodes,
    candidates: P.candidates.length,
    elapsedMs: Date.now() - started,
    lowerBound: lb,
  };
}
