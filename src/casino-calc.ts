/**
 * Game hash, catalog, and decrypt calls. The composition runs in libzkcasino.
 */
import { bridgeCall } from './player-bridge-ffi';
import type { Ciphertext, PrivateKey, PublicKey } from './zk-casino';

function enc(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(enc);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = enc(item);
    }
    return out;
  }
  return value;
}

function call(kind: number, variant: number, fn: string, fields: Record<string, unknown>): Record<string, unknown> {
  const result = bridgeCall(kind, variant, {
    op: 'calc',
    fn,
    ...(enc(fields) as Record<string, unknown>),
  });
  if (result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : `calc ${fn} failed`);
  }
  return result;
}

function dec(value: unknown): bigint {
  return BigInt(value as string | number | bigint);
}

function decCt(value: unknown): Ciphertext {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('expected 4-limb ciphertext');
  }
  return [dec(value[0]), dec(value[1]), dec(value[2]), dec(value[3])] as Ciphertext;
}

export function casinoShareCards(
  kind: number,
  fields: Record<string, unknown>,
  variant = 0,
): { finalHash: bigint; cards: bigint[] } {
  const result = call(kind, variant, 'shareCardHashes', fields);
  if (!Array.isArray(result.cards)) throw new Error('calc shareCardHashes returned no cards');
  return {
    finalHash: dec(result.value),
    cards: result.cards.map(dec),
  };
}

export function casinoShareBalls(
  kind: number,
  fields: Record<string, unknown>,
  variant = 0,
): { finalHash: bigint; balls: bigint[] } {
  const result = call(kind, variant, 'shareBallHashes', fields);
  if (!Array.isArray(result.balls)) throw new Error('calc shareBallHashes returned no balls');
  return {
    finalHash: dec(result.value),
    balls: result.balls.map(dec),
  };
}

export function casinoShareStreets(
  kind: number,
  fields: Record<string, unknown>,
  variant = 0,
): { finalHash: bigint; streets: bigint[] } {
  const result = call(kind, variant, 'shareStreetHashes', fields);
  if (!Array.isArray(result.streets)) throw new Error('calc shareStreetHashes returned no streets');
  return {
    finalHash: dec(result.value),
    streets: result.streets.map(dec),
  };
}

export function casinoFr(
  kind: number,
  fn: string,
  fields: Record<string, unknown>,
  variant = 0,
): bigint {
  return dec(call(kind, variant, fn, fields).value);
}

const SEAL_ACCOUNT_SLOTS = 14;
const SEAL_ACCOUNT_ROWS = 4;

/** Borsh body the seal callback writes, before the unused commitment field. */
const SEAL_ROWS_END =
  8 + 32 + 2 + SEAL_ACCOUNT_SLOTS * 32 + 32 + 16 + SEAL_ACCOUNT_ROWS * 32;

function anyNonZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) return true;
  }
  return false;
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 16; i += 1) {
    value |= BigInt(data[offset + i]!) << BigInt(8 * i);
  }
  return value;
}

/**
 * Read a seal account without the native player.
 *
 * The macOS player command is asynchronous. `casinoSealAccount` goes through
 * a synchronous bridge and throws in the WebView, so the showdown wait never
 * observes a callback that has already landed.
 */
export function decodeSealAccount(data: Uint8Array): SealedShowdownAccount {
  if (data.length < SEAL_ROWS_END) {
    throw new Error(`seal account is ${data.length} bytes, need ${SEAL_ROWS_END}`);
  }
  let at = 8;
  const gameId = data.slice(at, at + 32);
  at += 32;
  const playerIndex = data[at]!;
  const nActive = data[at + 1]!;
  at += 2;
  const coefficientsCiphertext: Uint8Array[] = [];
  let anyCiphertext = false;
  for (let slot = 0; slot < SEAL_ACCOUNT_SLOTS; slot += 1) {
    const ciphertext = data.slice(at, at + 32);
    at += 32;
    anyCiphertext = anyCiphertext || anyNonZero(ciphertext);
    coefficientsCiphertext.push(ciphertext);
  }
  const encryptionPubkey = data.slice(at, at + 32);
  at += 32;
  const nonce = readU128LE(data, at);
  at += 16;
  let anyRow = false;
  for (let row = 0; row < SEAL_ACCOUNT_ROWS; row += 1) {
    anyRow = anyRow || anyNonZero(data.subarray(at, at + 32));
    at += 32;
  }
  return {
    data,
    written: anyCiphertext && anyRow,
    gameId,
    playerIndex,
    nActive,
    coefficientsCiphertext,
    encryptionPubkey,
    nonce,
  };
}

/** `SealedShowdownCoefficients` as libzkcasino decodes it. */
export interface SealedShowdownAccount {
  /** Raw account data, for re-checking decrypted coefficients against the rows. */
  data: Uint8Array;
  /** The Arcis callback has written the ciphertexts and all four rows. */
  written: boolean;
  gameId: Uint8Array;
  playerIndex: number;
  nActive: number;
  coefficientsCiphertext: Uint8Array[];
  encryptionPubkey: Uint8Array;
  nonce: bigint;
  /** Poseidon of the four rows, once written. Light binds the showdown proof to it. */
  coefficientCommitment?: bigint;
}

function hexBytes(value: unknown): Uint8Array {
  return Uint8Array.from(Buffer.from(value as string, 'hex'));
}

/**
 * Decode a seal account in libzkcasino. With `coefficients`, libzkcasino also
 * checks that the decrypted slots produce the account rows.
 */
export function casinoSealAccount(
  data: Uint8Array,
  coefficients?: readonly bigint[],
): SealedShowdownAccount {
  const result = call(0, 0, 'sealAccount', {
    data: Buffer.from(data).toString('hex'),
    ...(coefficients ? { coefficients } : {}),
  });
  if (!Array.isArray(result.ciphertexts)) throw new Error('calc sealAccount returned no ciphertexts');
  return {
    data,
    written: result.written === true,
    gameId: hexBytes(result.gameId),
    playerIndex: Number(result.playerIndex),
    nActive: Number(result.nActive),
    coefficientsCiphertext: result.ciphertexts.map(hexBytes),
    encryptionPubkey: hexBytes(result.encryptionPubkey),
    nonce: dec(result.nonce),
    ...(result.commitment !== undefined ? { coefficientCommitment: dec(result.commitment) } : {}),
  };
}

export function casinoDeck(kind: number, count: number, decks = 1, variant = 0): Ciphertext[] {
  const deck = call(kind, variant, 'initialDeck', { count, decks }).deck;
  if (!Array.isArray(deck)) throw new Error('calc initialDeck returned no deck');
  return deck.map(decCt);
}

export function casinoDecrypt(
  kind: number,
  privateKey: PrivateKey | bigint,
  cards: Ciphertext[],
  partials: Ciphertext[][],
  variant = 0,
): bigint[] {
  const indices = call(kind, variant, 'decrypt', { privateKey, cards, partials }).cardIndices;
  if (!Array.isArray(indices)) throw new Error('calc decrypt returned no cardIndices');
  return indices.map((value) => dec(value));
}

export type { PublicKey };
