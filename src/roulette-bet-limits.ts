/**
 * Roulette room bet limits: each of the 12 class amounts must be 0 or in [min, max].
 */

export function assertRouletteBetAmounts(
  amounts: readonly bigint[],
  minBet: bigint,
  maxBet: bigint,
): void {
  if (minBet <= 0n || minBet > maxBet) {
    throw new Error(`invalid roulette room limits min=${minBet} max=${maxBet}`);
  }
  if (amounts.length !== 12) {
    throw new Error(`expected 12 roulette class amounts, got ${amounts.length}`);
  }
  let any = false;
  for (let i = 0; i < 12; i++) {
    const amt = amounts[i]!;
    if (amt === 0n) continue;
    any = true;
    if (amt < minBet || amt > maxBet) {
      throw new Error(
        `roulette bet class ${i} amount ${amt} outside [${minBet}, ${maxBet}]`,
      );
    }
  }
  if (!any) {
    throw new Error('roulette bet book is empty (all zero)');
  }
}
