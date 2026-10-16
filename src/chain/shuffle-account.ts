/**
 * Shoe-sized shuffle staging layout. Matches on-chain `shuffle_layout`.
 * An 8-deck shoe is the ceiling. Smaller shoes (and every non-shoe game)
 * allocate only the bytes that shoe needs.
 */
import { GameKind } from '../game-config';

export const SHUFFLE_HEADER_SIZE = 8 + 32 + 8 + 2 + 1 + 2;
export const PREPARE_INPUTS_PER_TX = 16;
/** Solana create/realloc cap. A smaller shoe still starts at this size. */
export const MAX_CPI_ALLOC = 10_240;
export const EIGHT_DECK_CALLER_INPUTS = 8 * 52 * 4 + 1;

export function shuffleInputsAccountSize(callerInputs: number): number {
  const chunks = Math.ceil(callerInputs / PREPARE_INPUTS_PER_TX);
  const fill = Math.ceil(callerInputs / 8);
  const prep = Math.ceil(chunks / 8);
  return SHUFFLE_HEADER_SIZE + 32 * callerInputs + 64 + 2 + fill + prep + chunks * 64;
}

/** Little-endian prepared-count offset for this caller-input count. */
export function preparedCountOffset(callerInputs: number): number {
  return SHUFFLE_HEADER_SIZE + 32 * callerInputs + 64;
}

const COUNT_OFFSET = 8 + 32 + 8 + 2 + 1;

function maskPopcount(mask: Buffer, bits: number): number {
  let set = 0;
  for (let i = 0; i < bits; i++) {
    if ((mask[i >> 3]! & (1 << (i & 7))) !== 0) set += 1;
  }
  return set;
}

/** True when every caller field has been copied into the shuffle buffer. */
export function shuffleBufferFilled(data: Buffer, callerInputs: number): boolean {
  if (data.length < COUNT_OFFSET + 2) return false;
  if (data.readUInt16LE(COUNT_OFFSET) !== callerInputs) return false;
  const preparedAt = preparedCountOffset(callerInputs);
  const fillLen = Math.ceil(callerInputs / 8);
  if (data.length < preparedAt + 2 + fillLen) return false;
  const fill = data.subarray(preparedAt + 2, preparedAt + 2 + fillLen);
  return maskPopcount(fill, callerInputs) === callerInputs;
}

/** On-chain shuffle buffer, so a failed finalize says which check missed. */
export function describeShuffleBuffer(data: Buffer, callerInputs: number): string {
  const chunks = Math.ceil(callerInputs / PREPARE_INPUTS_PER_TX);
  const fillLen = Math.ceil(callerInputs / 8);
  const prepLen = Math.ceil(chunks / 8);
  const preparedAt = preparedCountOffset(callerInputs);
  const count = data.length >= COUNT_OFFSET + 2 ? data.readUInt16LE(COUNT_OFFSET) : -1;
  const prepared = data.length >= preparedAt + 2 ? data.readUInt16LE(preparedAt) : -1;
  const fill = data.subarray(preparedAt + 2, preparedAt + 2 + fillLen);
  const prep = data.subarray(preparedAt + 2 + fillLen, preparedAt + 2 + fillLen + prepLen);
  return `len=${data.length} count=${count}/${callerInputs} fill=${maskPopcount(fill, callerInputs)}/${callerInputs} prepared=${prepared} chunks=${maskPopcount(prep, chunks)}/${chunks}`;
}

export function deckStateAccountSize(deckFields: number): number {
  return 8 + deckFields * 32;
}

/**
 * Caller-staged shuffle public inputs for the admin's table config.
 * Blackjack, war, and baccarat use `shoeDecks` of 1, 6, or 8.
 */
export function shuffleCallerInputs(
  kind: number,
  shoeDecks: number,
  rouletteVariant = 0,
): number {
  let cards: number;
  if (kind === GameKind.Poker) cards = 52;
  else if (
    kind === GameKind.Baccarat
    || kind === GameKind.Blackjack
    || kind === GameKind.War
  ) {
    cards = 52 * shoeDecks;
  } else if (kind === GameKind.Roulette) cards = rouletteVariant;
  else if (kind === GameKind.Craps) cards = 12;
  else if (kind === GameKind.Keno) cards = 80;
  else if (kind === GameKind.Slots) cards = rouletteVariant * 22;
  else if (kind === GameKind.Bingo) cards = rouletteVariant;
  else cards = 52;
  const fields = cards * 4;
  return fields + 1;
}
