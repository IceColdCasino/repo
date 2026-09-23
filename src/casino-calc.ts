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

export function casinoFr(
  kind: number,
  fn: string,
  fields: Record<string, unknown>,
  variant = 0,
): bigint {
  return dec(call(kind, variant, fn, fields).value);
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
