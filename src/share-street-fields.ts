import type { Ciphertext } from './zk-casino';

/** Poseidon width. Each street is uploaded as chunks of this many fields. */
export const SHARE_UPLOAD_CHUNK = 12;

/**
 * One street's partials, recipient-major, matching `streetHashFromFlat`.
 * `cards` are the card indexes inside that street.
 */
export function streetFields(rows: Ciphertext[][], cards: readonly number[]): bigint[] {
  const fields: bigint[] = [];
  for (const row of rows) {
    for (const card of cards) {
      const limbs = row[card];
      if (!limbs) throw new Error(`street card ${card} is missing`);
      fields.push(limbs[0], limbs[1], limbs[2], limbs[3]);
    }
  }
  return fields;
}

function expectGrid(rows: Ciphertext[][], recipients: number, cards: number, label: string): void {
  if (rows.length !== recipients || rows.some((row) => row.length !== cards)) {
    throw new Error(`${label} share grid must be ${recipients}×${cards}`);
  }
}

/** Poker: 10 hole pairs, flop, turn, river. Grid is 9 recipients × 25 cards. */
export function pokerStreetFieldGroups(rows: Ciphertext[][]): bigint[][] {
  expectGrid(rows, 9, 25, 'poker');
  const groups: bigint[][] = [];
  for (let street = 0; street < 10; street++) {
    groups.push(streetFields(rows, [street * 2, street * 2 + 1]));
  }
  groups.push(streetFields(rows, [20, 21, 22]));
  groups.push(streetFields(rows, [23]));
  groups.push(streetFields(rows, [24]));
  return groups;
}

/** Blackjack: one hash per card in the 7×16 chunk. */
export function blackjackCardFieldGroups(rows: Ciphertext[][]): bigint[][] {
  expectGrid(rows, 7, 16, 'blackjack');
  return Array.from({ length: 16 }, (_, card) => streetFields(rows, [card]));
}

/** Bingo: one hash per ball in the 11×5 window. */
export function bingoBallFieldGroups(rows: Ciphertext[][]): bigint[][] {
  expectGrid(rows, 11, 5, 'bingo');
  return Array.from({ length: 5 }, (_, ball) => streetFields(rows, [ball]));
}

/** How many 12-field uploads a street list becomes. */
export function shareStreetChunkCount(streets: readonly (readonly unknown[])[]): number {
  let count = 0;
  for (const street of streets) count += Math.ceil(street.length / SHARE_UPLOAD_CHUNK);
  return count;
}

/** Baccarat: player hand, banker hand, player third, banker third. */
export function baccaratStreetFieldGroups(rows: Ciphertext[][]): bigint[][] {
  expectGrid(rows, 11, 6, 'baccarat');
  return [
    streetFields(rows, [0, 1]),
    streetFields(rows, [2, 3]),
    streetFields(rows, [4]),
    streetFields(rows, [5]),
  ];
}
