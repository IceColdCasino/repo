/** 3-reel Wilson / Double Diamond and 5-reel Starburst-style evaluators. */

export const ThreeReelSymbol = {
  Blank: 0,
  Cherry: 1,
  SingleBar: 2,
  DoubleBar: 3,
  TripleBar: 4,
  Single7: 5,
  Double7: 6,
  Wild: 7,
} as const;

export const FiveReelSymbol = {
  Purple: 0,
  Blue: 1,
  Orange: 2,
  Green: 3,
  Yellow: 4,
  Seven: 5,
  Bar: 6,
  Wild: 7,
} as const;

const THREE_REEL_PAY: readonly (readonly number[])[] = [
  [500, 1000, 6000],
  [200, 400, 600],
  [75, 150, 225],
  [40, 80, 120],
  [20, 40, 60],
  [10, 20, 30],
  [5, 10, 15],
];

/** Starburst multipliers in tenths of the total bet, for 3 / 4 / 5 of a kind. */
const FIVE_REEL_PAY10: readonly (readonly number[])[] = [
  [5, 10, 25],
  [5, 10, 25],
  [7, 15, 40],
  [8, 20, 50],
  [10, 25, 60],
  [25, 60, 120],
  [50, 200, 250],
];

/** Wilson-style 22-stop physical strip (identical reels). */
export const WILSON_STRIP_22: readonly number[] = [
  3, 0, 5, 0, 3, 0, 6, 0, 4, 0, 5, 0, 2, 0, 5, 0, 2, 0, 6, 0, 4, 0,
];

/** Starburst-style 22-stop strips. Wilds only on reels 2–4 (indices 1–3). */
export const STARBURST_STRIPS_22: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0],
  [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5],
  [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5],
  [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5],
  [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0],
];

export function reelWindow(
  strip: readonly number[],
  centerIndex: number,
): { above: number; center: number; below: number } {
  const n = strip.length;
  const i = ((centerIndex % n) + n) % n;
  return {
    above: strip[(i + n - 1) % n]!,
    center: strip[i]!,
    below: strip[(i + 1) % n]!,
  };
}

export const STARBURST_PAYLINES: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0],
];

function isWild(symbol: number): boolean {
  return symbol === 7;
}

export function evaluateThreeReel(symbols: readonly number[], coinBet: number): number {
  if (coinBet !== 1 && coinBet !== 2 && coinBet !== 3) {
    throw new Error(`coinBet must be 1, 2, or 3, got ${coinBet}`);
  }
  if (symbols.length !== 3) {
    throw new Error(`expected 3 symbols, got ${symbols.length}`);
  }

  const as = (want: (s: number) => boolean) =>
    symbols.every((symbol) => isWild(symbol) || want(symbol));

  const wins = [
    as((s) => s === ThreeReelSymbol.Double7),
    as((s) => s === ThreeReelSymbol.Single7),
    as((s) => s === ThreeReelSymbol.Single7 || s === ThreeReelSymbol.Double7),
    as((s) => s === ThreeReelSymbol.TripleBar),
    as((s) => s === ThreeReelSymbol.DoubleBar),
    as((s) => s === ThreeReelSymbol.SingleBar),
    as((s) =>
      s === ThreeReelSymbol.SingleBar
      || s === ThreeReelSymbol.DoubleBar
      || s === ThreeReelSymbol.TripleBar),
  ];
  const index = wins.findIndex(Boolean);
  if (index < 0) {
    return 0;
  }
  return THREE_REEL_PAY[index]![coinBet - 1]!;
}

function expandStarburst(grid: number[][]): number[][] {
  return grid.map((reel, reelIndex) => {
    if (reelIndex < 1 || reelIndex > 3) {
      return [...reel];
    }
    if (reel.some(isWild)) {
      return [7, 7, 7];
    }
    return [...reel];
  });
}

function countMatchFromLeft(symbols: readonly number[]): { count: number; symbol: number } {
  const wildSub = symbols.map((symbol, index) => index >= 1 && index <= 3 && isWild(symbol));
  let target = 0;
  let seen = false;
  for (let i = 0; i < 5; i += 1) {
    if (!seen && !wildSub[i]) {
      target = symbols[i]!;
      seen = true;
    }
  }
  const symbol = !seen || target === 7 ? FiveReelSymbol.Bar : target;
  let count = 0;
  for (let i = 0; i < 5; i += 1) {
    if (wildSub[i] || symbols[i] === symbol) {
      count += 1;
    } else {
      break;
    }
  }
  return { count, symbol };
}

function payMult10(symbol: number, count: number): number {
  if (count < 3 || count > 5 || symbol < 0 || symbol > 6) {
    return 0;
  }
  return FIVE_REEL_PAY10[symbol]![count - 3]!;
}

function evaluatePayline(symbols: readonly number[]): number {
  const ltr = countMatchFromLeft(symbols);
  const rtl = countMatchFromLeft([...symbols].reverse());
  return Math.max(payMult10(ltr.symbol, ltr.count), payMult10(rtl.symbol, rtl.count));
}

export function evaluateThreeReelStops(centers: readonly number[], coinBet: number): number {
  if (centers.length !== 3) {
    throw new Error(`expected 3 center stops, got ${centers.length}`);
  }
  return evaluateThreeReel(
    centers.map((index) => reelWindow(WILSON_STRIP_22, index).center),
    coinBet,
  );
}

/** Payout in tenths of a coin (`mult10 * coinBet`). */
export function evaluateFiveReel(symbols: readonly number[], coinBet: number): number {
  if (coinBet !== 1 && coinBet !== 2 && coinBet !== 3) {
    throw new Error(`coinBet must be 1, 2, or 3, got ${coinBet}`);
  }
  if (symbols.length !== 15) {
    throw new Error(`expected 15 symbols (5×3), got ${symbols.length}`);
  }
  const grid = [0, 1, 2, 3, 4].map((reel) => [
    symbols[reel * 3]!,
    symbols[reel * 3 + 1]!,
    symbols[reel * 3 + 2]!,
  ]);
  const expanded = expandStarburst(grid);
  let mult10 = 0;
  for (const line of STARBURST_PAYLINES) {
    const lineSymbols = line.map((row, reel) => expanded[reel]![row]!);
    mult10 += evaluatePayline(lineSymbols);
  }
  return mult10 * coinBet;
}

export function evaluateFiveReelStops(centers: readonly number[], coinBet: number): number {
  if (centers.length !== 5) {
    throw new Error(`expected 5 center stops, got ${centers.length}`);
  }
  const symbols = centers.flatMap((index, reel) => {
    const window = reelWindow(STARBURST_STRIPS_22[reel]!, index);
    return [window.above, window.center, window.below];
  });
  return evaluateFiveReel(symbols, coinBet);
}
