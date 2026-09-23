/** Come-out vs point-phase craps actions. `action % 3` is the resolution class. */

export const CrapsPhase = {
  ComeOut: 0,
  Point: 1,
} as const;

/** Come-out: 0–2. Point: 3–5. Same order in each phase: Pass wins, Don't Pass wins, continue. */
export const CrapsAction = {
  Natural: 0,
  Craps: 1,
  Point: 2,
  Pass: 3,
  SevenOut: 4,
  Reroll: 5,
} as const;

export type CrapsAction = (typeof CrapsAction)[keyof typeof CrapsAction];

const POINT_TOTALS = new Set([4, 5, 6, 8, 9, 10]);

export function diceTotal(diceValues: readonly number[]): number {
  if (diceValues.length !== 2) {
    throw new Error(`expected 2 dice, got ${diceValues.length}`);
  }
  for (const die of diceValues) {
    if (!Number.isInteger(die) || die < 0 || die > 5) {
      throw new Error(`die face must be 0–5, got ${die}`);
    }
  }
  return diceValues[0]! + diceValues[1]! + 2;
}

export function evaluateCraps(
  diceValues: readonly number[],
  phase: number,
  point: number,
): { action: CrapsAction; pointOut: number } {
  if (phase !== 0 && phase !== 1) {
    throw new Error(`phase must be 0 or 1, got ${phase}`);
  }
  const total = diceTotal(diceValues);

  if (phase === CrapsPhase.ComeOut) {
    if (point !== 0) {
      throw new Error(`come-out point must be 0, got ${point}`);
    }
    if (total === 7 || total === 11) {
      return { action: CrapsAction.Natural, pointOut: 0 };
    }
    if (total === 2 || total === 3 || total === 12) {
      return { action: CrapsAction.Craps, pointOut: 0 };
    }
    return { action: CrapsAction.Point, pointOut: total };
  }

  if (!POINT_TOTALS.has(point)) {
    throw new Error(`point must be 4, 5, 6, 8, 9, or 10, got ${point}`);
  }
  if (total === point) {
    return { action: CrapsAction.Pass, pointOut: point };
  }
  if (total === 7) {
    return { action: CrapsAction.SevenOut, pointOut: point };
  }
  return { action: CrapsAction.Reroll, pointOut: point };
}

/** Wikipedia bank-craps families — 12 types, unique (type, modifier) like roulette. */
export const CrapsBetType = {
  Pass: 0,
  DontPass: 1,
  Come: 2,
  DontCome: 3,
  Odds: 4,
  Place: 5,
  Buy: 6,
  Lay: 7,
  Field: 8,
  Proposition: 9,
  Hardway: 10,
  Big: 11,
} as const;
export type CrapsBetType = (typeof CrapsBetType)[keyof typeof CrapsBetType];

export const CrapsProp = {
  Any7: 0,
  AnyCraps: 1,
  Yo: 2,
  AceDeuce: 3,
  Aces: 4,
  Twelve: 5,
  HiLo: 6,
} as const;
export type CrapsProp = (typeof CrapsProp)[keyof typeof CrapsProp];

export const MAX_CRAPS_BETS = 12;
/** Showdown poly hash: 12 bet codes + action + pointOut. */
export const CRAPS_SHOWDOWN_TERMS = MAX_CRAPS_BETS + 2;
export const CRAPS_LOSE = 0;
export const CRAPS_KEEP = 1;
export const CRAPS_PAYOUT_SCALE = 30;

const POINT_NUMS = [4, 5, 6, 8, 9, 10] as const;
const HARD_NUMS = [4, 6, 8, 10] as const;
const MOD_MAX: Record<number, number> = {
  0: 0,
  1: 0,
  2: 6,
  3: 6,
  4: 23,
  5: 5,
  6: 5,
  7: 5,
  8: 0,
  9: 6,
  10: 3,
  11: 1,
};

/** [type, modifier] matching PackBet / ConstrainCrapsBet. */
export type CrapsBet = readonly [type: number, modifier: number];

/** Profit code: 1 + 30 * (p/q) for a p:q win. */
export function crapsWin(profitNum: number, profitDen = 1): number {
  if (profitDen === 0 || (30 * profitNum) % profitDen !== 0) {
    throw new Error(`craps win ${profitNum}:${profitDen} is not a 30th`);
  }
  return CRAPS_KEEP + (CRAPS_PAYOUT_SCALE * profitNum) / profitDen;
}

export function packCrapsBet(type: number, modifier: number): bigint {
  return BigInt(type) + BigInt(modifier) * 16n;
}

export function assertUniqueCrapsBets(bets: readonly CrapsBet[]): void {
  const seen = new Set<bigint>();
  for (const [type, modifier] of bets) {
    const packed = packCrapsBet(type, modifier);
    if (seen.has(packed)) {
      throw new Error(
        `Duplicate craps bet type=${type} modifier=${modifier} (packed=${packed})`,
      );
    }
    seen.add(packed);
  }
}

export function assertValidCrapsBet(type: number, modifier: number): void {
  if (!Number.isInteger(type) || type < 0 || type > 11) {
    throw new Error(`Invalid craps bet type ${type}`);
  }
  if (!Number.isInteger(modifier) || modifier < 0) {
    throw new Error(`Invalid craps bet modifier ${modifier}`);
  }
  const max = MOD_MAX[type];
  if (max === undefined || modifier > max) {
    throw new Error(`Craps bet type=${type} modifier=${modifier} out of range (max ${max})`);
  }
}

export function assertValidCrapsBets(bets: readonly CrapsBet[]): void {
  for (const [type, modifier] of bets) {
    assertValidCrapsBet(type, modifier);
  }
  assertUniqueCrapsBets(bets);
}

export function padCrapsBets(bets: readonly CrapsBet[]): CrapsBet[] {
  if (bets.length === MAX_CRAPS_BETS) {
    for (const [type, modifier] of bets) {
      assertValidCrapsBet(type, modifier);
    }
    return bets.map(b => [b[0], b[1]] as const);
  }
  assertValidCrapsBets(bets);
  const out: CrapsBet[] = bets.map(b => [b[0], b[1]] as const);
  while (out.length < MAX_CRAPS_BETS) out.push([0, 0]);
  return out.slice(0, MAX_CRAPS_BETS);
}

function keepLoseWin(hit: boolean, lose: boolean, winCode: number): number {
  if (hit && lose) throw new Error('craps hit and lose both set');
  if (hit) return winCode;
  if (lose) return CRAPS_LOSE;
  return CRAPS_KEEP;
}

function pointNumber(index: number): number {
  return POINT_NUMS[index]!;
}

function placeWinCode(index: number): number {
  if (index === 0 || index === 5) return crapsWin(9, 5);
  if (index === 1 || index === 4) return crapsWin(7, 5);
  return crapsWin(7, 6);
}

function trueOddsWinCode(index: number): number {
  if (index === 0 || index === 5) return crapsWin(2);
  if (index === 1 || index === 4) return crapsWin(3, 2);
  return crapsWin(6, 5);
}

function layOddsWinCode(index: number): number {
  if (index === 0 || index === 5) return crapsWin(1, 2);
  if (index === 1 || index === 4) return crapsWin(2, 3);
  return crapsWin(5, 6);
}

function evaluatePass(
  phase: number,
  point: number,
  total: number,
): number {
  if (phase === 0) {
    return keepLoseWin(total === 7 || total === 11, total === 2 || total === 3 || total === 12, crapsWin(1));
  }
  return keepLoseWin(total === point, total === 7, crapsWin(1));
}

function evaluateDontPass(
  phase: number,
  point: number,
  total: number,
): number {
  if (phase === 0) {
    return keepLoseWin(total === 2 || total === 3, total === 7 || total === 11, crapsWin(1));
  }
  return keepLoseWin(total === 7, total === point, crapsWin(1));
}

function evaluateCome(modifier: number, total: number): number {
  if (modifier === 0) {
    return keepLoseWin(total === 7 || total === 11, total === 2 || total === 3 || total === 12, crapsWin(1));
  }
  const num = pointNumber(modifier - 1);
  return keepLoseWin(total === num, total === 7, crapsWin(1));
}

function evaluateDontCome(modifier: number, total: number): number {
  if (modifier === 0) {
    return keepLoseWin(total === 2 || total === 3, total === 7 || total === 11, crapsWin(1));
  }
  const num = pointNumber(modifier - 1);
  return keepLoseWin(total === 7, total === num, crapsWin(1));
}

function evaluateOdds(
  modifier: number,
  phase: number,
  point: number,
  total: number,
): number {
  const family = Math.floor(modifier / 6);
  const idx = modifier % 6;
  const num = pointNumber(idx);
  const take = trueOddsWinCode(idx);
  const lay = layOddsWinCode(idx);
  if (family === 0) {
    const working = phase === 1 && point === num;
    return keepLoseWin(working && total === num, working && total === 7, take);
  }
  if (family === 1) {
    const working = phase === 1 && point === num;
    return keepLoseWin(working && total === 7, working && total === num, lay);
  }
  if (family === 2) {
    const working = phase === 1;
    return keepLoseWin(working && total === num, working && total === 7, take);
  }
  return keepLoseWin(total === 7, total === num, lay);
}

function evaluatePlace(modifier: number, phase: number, total: number): number {
  const num = pointNumber(modifier);
  return keepLoseWin(phase === 1 && total === num, phase === 1 && total === 7, placeWinCode(modifier));
}

function evaluateBuy(modifier: number, phase: number, total: number): number {
  const num = pointNumber(modifier);
  return keepLoseWin(phase === 1 && total === num, phase === 1 && total === 7, trueOddsWinCode(modifier));
}

function evaluateLay(modifier: number, total: number): number {
  const num = pointNumber(modifier);
  return keepLoseWin(total === 7, total === num, layOddsWinCode(modifier));
}

function evaluateField(total: number): number {
  const hit = total === 2 || total === 3 || total === 4 || total === 9
    || total === 10 || total === 11 || total === 12;
  const win = total === 2 || total === 12 ? crapsWin(2) : crapsWin(1);
  return keepLoseWin(hit, !hit, win);
}

function evaluateProposition(modifier: number, total: number): number {
  const table: [boolean, number][] = [
    [total === 7, crapsWin(4)],
    [total === 2 || total === 3 || total === 12, crapsWin(7)],
    [total === 11, crapsWin(15)],
    [total === 3, crapsWin(15)],
    [total === 2, crapsWin(30)],
    [total === 12, crapsWin(30)],
    [total === 2 || total === 12, crapsWin(15)],
  ];
  const [hit, win] = table[modifier]!;
  return keepLoseWin(hit, !hit, win);
}

function evaluateHardway(
  modifier: number,
  phase: number,
  total: number,
  isHard: boolean,
): number {
  const num = HARD_NUMS[modifier]!;
  const working = phase === 1;
  const win = modifier === 0 || modifier === 3 ? crapsWin(7) : crapsWin(9);
  return keepLoseWin(working && isHard && total === num, working && (total === 7 || (!isHard && total === num)), win);
}

function evaluateBig(modifier: number, phase: number, total: number): number {
  const num = modifier === 0 ? 6 : 8;
  return keepLoseWin(phase === 1 && total === num, phase === 1 && total === 7, crapsWin(1));
}

/** Per-bet result matching circuits/craps_bet_eval.circom EvaluateCrapsBet. */
export function evaluateCrapsBet(
  type: number,
  modifier: number,
  diceValues: readonly number[],
  phase: number,
  point: number,
): number {
  assertValidCrapsBet(type, modifier);
  if (phase !== 0 && phase !== 1) {
    throw new Error(`phase must be 0 or 1, got ${phase}`);
  }
  const total = diceTotal(diceValues);
  const isHard = diceValues[0] === diceValues[1];
  switch (type) {
    case CrapsBetType.Pass:
      return evaluatePass(phase, point, total);
    case CrapsBetType.DontPass:
      return evaluateDontPass(phase, point, total);
    case CrapsBetType.Come:
      return evaluateCome(modifier, total);
    case CrapsBetType.DontCome:
      return evaluateDontCome(modifier, total);
    case CrapsBetType.Odds:
      return evaluateOdds(modifier, phase, point, total);
    case CrapsBetType.Place:
      return evaluatePlace(modifier, phase, total);
    case CrapsBetType.Buy:
      return evaluateBuy(modifier, phase, total);
    case CrapsBetType.Lay:
      return evaluateLay(modifier, total);
    case CrapsBetType.Field:
      return evaluateField(total);
    case CrapsBetType.Proposition:
      return evaluateProposition(modifier, total);
    case CrapsBetType.Hardway:
      return evaluateHardway(modifier, phase, total, isHard);
    case CrapsBetType.Big:
      return evaluateBig(modifier, phase, total);
    default:
      throw new Error(`Invalid craps bet type ${type}`);
  }
}

export function evaluateCrapsBets(
  bets: readonly CrapsBet[],
  diceValues: readonly number[],
  phase: number,
  point: number,
  nActualBets = bets.length,
): number[] {
  return bets.map((bet, i) =>
    i < nActualBets ? evaluateCrapsBet(bet[0], bet[1], diceValues, phase, point) : 0,
  );
}

/** Circuit `Showdown` public results: `[...12 bets, action, pointOut]`. */
export function evaluateCrapsShowdown(
  bets: readonly CrapsBet[],
  diceValues: readonly number[],
  phase: number,
  point: number,
  nActualBets = bets.length,
): number[] {
  const padded = padCrapsBets(bets);
  const results = evaluateCrapsBets(padded, diceValues, phase, point, nActualBets);
  const table = evaluateCraps(diceValues, phase, point);
  return [...results, table.action, table.pointOut];
}
