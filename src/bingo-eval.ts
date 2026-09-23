/** 75-ball and 90-ball bingo card validation + pattern evaluation. */

export const BINGO_75_SHOE = 75;
export const BINGO_90_SHOE = 90;
export const BINGO_75_CELLS = 25;
export const BINGO_90_CELLS = 27;
export const BINGO_CHUNK_BALLS = 5;

export const BingoPattern75 = {
  AnyLine: 0,
  FourCorners: 1,
  Blackout: 2,
} as const;
export type BingoPattern75 = (typeof BingoPattern75)[keyof typeof BingoPattern75];

const COL75_LO = [1, 16, 31, 46, 61];
const COL75_HI = [15, 30, 45, 60, 75];
const COL90_LO = [1, 10, 20, 30, 40, 50, 60, 70, 80];
const COL90_HI = [9, 19, 29, 39, 49, 59, 69, 79, 90];

export function packBingoTerm(won: boolean, completionIndex: number): number {
  return (won ? 1 : 0) * 256 + completionIndex;
}

export function unpackBingoTerm(packed: number): { won: boolean; completionIndex: number } {
  return { won: packed >= 256, completionIndex: packed % 256 };
}

function assertUniqueNonZero(cells: readonly number[]): void {
  const seen = new Set<number>();
  for (const cell of cells) {
    if (cell === 0) continue;
    if (seen.has(cell)) throw new Error(`duplicate bingo number ${cell}`);
    seen.add(cell);
  }
}

export function assertValidBingo75Card(cells: readonly number[]): void {
  if (cells.length !== BINGO_75_CELLS) {
    throw new Error(`75-ball card must have ${BINGO_75_CELLS} cells`);
  }
  if (cells[12] !== 0) throw new Error('75-ball center must be the free space (0)');
  for (let i = 0; i < BINGO_75_CELLS; i++) {
    const cell = cells[i]!;
    if (i === 12) continue;
    const col = i % 5;
    if (!Number.isInteger(cell) || cell < COL75_LO[col]! || cell > COL75_HI[col]!) {
      throw new Error(`75-ball cell ${i} must be in ${COL75_LO[col]}–${COL75_HI[col]}, got ${cell}`);
    }
  }
  assertUniqueNonZero(cells);
}

export function assertValidBingo90Card(cells: readonly number[]): void {
  if (cells.length !== BINGO_90_CELLS) {
    throw new Error(`90-ball ticket must have ${BINGO_90_CELLS} cells`);
  }
  for (let r = 0; r < 3; r++) {
    let filled = 0;
    for (let c = 0; c < 9; c++) {
      const cell = cells[r * 9 + c]!;
      if (cell === 0) continue;
      if (!Number.isInteger(cell) || cell < COL90_LO[c]! || cell > COL90_HI[c]!) {
        throw new Error(`90-ball cell ${r * 9 + c} must be in ${COL90_LO[c]}–${COL90_HI[c]} or 0, got ${cell}`);
      }
      filled += 1;
    }
    if (filled !== 5) throw new Error(`90-ball row ${r} must have 5 numbers, got ${filled}`);
  }
  assertUniqueNonZero(cells);
}

export function sampleBingo75Card(salt = 0): number[] {
  const cells = new Array<number>(25).fill(0);
  for (let col = 0; col < 5; col++) {
    const start = COL75_LO[col]!;
    for (let row = 0; row < 5; row++) {
      const i = row * 5 + col;
      if (i === 12) continue;
      cells[i] = start + ((row + salt) % 15);
    }
  }
  assertValidBingo75Card(cells);
  return cells;
}

export function sampleBingo90Card(salt = 0): number[] {
  const cells = new Array<number>(27).fill(0);
  for (let r = 0; r < 3; r++) {
    const cols = [0, 1, 3, 5, 8];
    for (let k = 0; k < 5; k++) {
      const c = cols[k]!;
      const lo = COL90_LO[c]!;
      cells[r * 9 + c] = lo + ((r + k + salt) % (COL90_HI[c]! - lo + 1));
    }
  }
  assertValidBingo90Card(cells);
  return cells;
}

function mark75(cells: readonly number[], called: readonly number[]): boolean[] {
  const marked = cells.map((cell, i) => i === 12 || cell === 0);
  const drawn = new Set(called.map((b) => b + 1));
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0 && drawn.has(cells[i]!)) marked[i] = true;
  }
  return marked;
}

function anyLine75(marked: readonly boolean[]): boolean {
  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every((c) => marked[r * 5 + c])) return true;
  }
  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every((r) => marked[r * 5 + c])) return true;
  }
  if ([0, 6, 12, 18, 24].every((i) => marked[i])) return true;
  if ([4, 8, 12, 16, 20].every((i) => marked[i])) return true;
  return false;
}

function fourCorners75(marked: readonly boolean[]): boolean {
  return Boolean(marked[0] && marked[4] && marked[20] && marked[24]);
}

function blackout75(marked: readonly boolean[]): boolean {
  return marked.every(Boolean);
}

function patternHit75(marked: readonly boolean[], patternId: BingoPattern75): boolean {
  if (patternId === BingoPattern75.AnyLine) return anyLine75(marked);
  if (patternId === BingoPattern75.FourCorners) return fourCorners75(marked);
  return blackout75(marked);
}

function firstCompletion(
  nCalled: number,
  hitAt: (calledPrefix: number[]) => boolean,
  balls: readonly number[],
): number {
  for (let t = 0; t < nCalled; t++) {
    if (hitAt(balls.slice(0, t + 1) as number[])) return t + 1;
  }
  return 0;
}

export function evaluateBingo75(
  cells: readonly number[],
  balls: readonly number[],
  nCalled: number,
  patternId: BingoPattern75,
): { won: boolean; completionIndex: number; packed: number } {
  assertValidBingo75Card(cells);
  if (nCalled < 1 || nCalled > balls.length) {
    throw new Error(`nCalled ${nCalled} out of range for ${balls.length} balls`);
  }
  const completionIndex = firstCompletion(
    nCalled,
    (prefix) => patternHit75(mark75(cells, prefix), patternId),
    balls,
  );
  const won = completionIndex > 0;
  return { won, completionIndex, packed: packBingoTerm(won, completionIndex) };
}

function mark90(cells: readonly number[], called: readonly number[]): boolean[] {
  const drawn = new Set(called.map((b) => b + 1));
  return cells.map((cell) => cell !== 0 && drawn.has(cell));
}

function completedRows90(cells: readonly number[], marked: readonly boolean[]): number {
  let rows = 0;
  for (let r = 0; r < 3; r++) {
    let need = 0;
    let got = 0;
    for (let c = 0; c < 9; c++) {
      const i = r * 9 + c;
      if (cells[i] !== 0) {
        need += 1;
        if (marked[i]) got += 1;
      }
    }
    if (need === 5 && got === 5) rows += 1;
  }
  return rows;
}

export function evaluateBingo90(
  cells: readonly number[],
  balls: readonly number[],
  nCalled: number,
): {
  oneLine: { won: boolean; completionIndex: number; packed: number };
  twoLines: { won: boolean; completionIndex: number; packed: number };
  fullHouse: { won: boolean; completionIndex: number; packed: number };
} {
  assertValidBingo90Card(cells);
  if (nCalled < 1 || nCalled > balls.length) {
    throw new Error(`nCalled ${nCalled} out of range for ${balls.length} balls`);
  }
  const term = (need: number) => {
    const completionIndex = firstCompletion(
      nCalled,
      (prefix) => completedRows90(cells, mark90(cells, prefix)) >= need,
      balls,
    );
    const won = completionIndex > 0;
    return { won, completionIndex, packed: packBingoTerm(won, completionIndex) };
  };
  return { oneLine: term(1), twoLines: term(2), fullHouse: term(3) };
}
