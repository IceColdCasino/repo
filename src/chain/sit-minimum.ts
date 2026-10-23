/** Chips that must sit in the personal account before a player can take a seat. */
export const MIN_SIT_CHIPS = 1000n;

export function hasSitChips(balance: bigint): boolean {
  return balance >= MIN_SIT_CHIPS;
}
