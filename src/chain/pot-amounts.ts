import type { PotSnapshot } from '../backend/types';

/** Transitional `pots_ct` slot: little-endian u64, remaining bytes zero. */
export function decodeSyncedU64Field(bytes: ArrayLike<number> | null | undefined): bigint | null {
  if (!bytes || bytes.length < 32) return null;
  for (let i = 8; i < 32; i += 1) {
    if (Number(bytes[i] ?? 0) !== 0) return null;
  }
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(Number(bytes[i] ?? 0)) << BigInt(8 * i);
  }
  return value;
}

export function bigintList(values: unknown): bigint[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    try {
      const raw = value != null && typeof value === 'object' && 'toString' in value
        ? String((value as { toString(): string }).toString())
        : String(value ?? '0');
      return BigInt(raw);
    } catch {
      return 0n;
    }
  });
}

function amountsFromEncrypted(
  fields: Array<ArrayLike<number> | null | undefined>,
): bigint[] | null {
  if (fields.length === 0) return null;
  const decoded = fields.map((field) => decodeSyncedU64Field(field));
  if (decoded.some((value) => value === null)) return null;
  return decoded.map((value) => value ?? 0n);
}

/**
 * Pot chips for the felt. Encrypted `pots_ct` wins when it decodes.
 * Plaintext `game_state.pots` is the mirror. Player totals cover a pot
 * slot that was never synced.
 */
export function choosePotAmounts(opts: {
  encryptedFields?: Array<ArrayLike<number> | null | undefined> | null;
  plaintextPots?: unknown;
  playerTotals?: unknown;
}): bigint[] {
  const fromCt = opts.encryptedFields ? amountsFromEncrypted(opts.encryptedFields) : null;
  if (fromCt && fromCt.some((amount) => amount > 0n)) return fromCt;
  const plain = bigintList(opts.plaintextPots);
  if (plain.some((amount) => amount > 0n)) return plain;
  const totals = bigintList(opts.playerTotals);
  const sum = totals.reduce((acc, amount) => acc + amount, 0n);
  if (sum > 0n) return [sum];
  if (fromCt) return fromCt;
  if (plain.length > 0) return plain;
  return [0n];
}

/** Keep pot indexes. Drop only the trailing empty pots. */
export function snapshotPots(amounts: bigint[]): PotSnapshot[] {
  let last = -1;
  amounts.forEach((amount, index) => {
    if (amount > 0n) last = index;
  });
  if (last < 0) return [{ amount: '0', lastBet: '0' }];
  return amounts.slice(0, last + 1).map((amount) => ({
    amount: amount.toString(),
    lastBet: '0',
  }));
}
