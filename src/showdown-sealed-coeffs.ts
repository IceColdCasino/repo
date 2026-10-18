import { RescueCipher, deserializeLE, getMXEPublicKey, serializeLE, x25519 } from '@arcium-hq/client';
import { randomBytes } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import type { AnchorProvider } from '@coral-xyz/anchor';
import type { TableEncryptionKey } from './bet-encryption';
import { casinoSealAccount, decodeSealAccount, type SealedShowdownAccount } from './casino-calc';
import { SEAL_SLOTS } from './host-showdown-coefficients';

export type { SealedShowdownAccount };

async function getMXEPublicKeyWithRetry(
  provider: AnchorProvider,
  programId: PublicKey,
  maxRetries = 10,
  retryDelayMs = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch {
      // retry
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function nonceToBytes(nonce: bigint): Uint8Array {
  const nonceBytes = Buffer.alloc(16);
  nonceBytes.writeBigUInt64LE(nonce & ((1n << 64n) - 1n));
  nonceBytes.writeBigUInt64LE(nonce >> 64n, 8);
  return nonceBytes;
}

function sharedCipher(playerKey: TableEncryptionKey, mxePublicKey: Uint8Array) {
  const sharedSecret = x25519.getSharedSecret(playerKey.privateKey, mxePublicKey);
  return new RescueCipher(sharedSecret);
}

/**
 * (result + 1) * c0 + c1 over the first two sealed slots. The second
 * polynomial limb is the constant 0.
 */
export function showdownTwoCoeffHash(result: bigint, coefficients: readonly bigint[]): bigint {
  return showdownTwoResultHash(result, 0n, coefficients);
}

/** (first + 1) * c0 + (second + 1) * c1. Both limbs carry an outcome. */
export function showdownTwoResultHash(
  first: bigint,
  second: bigint,
  coefficients: readonly bigint[],
): bigint {
  if (coefficients.length !== 2) {
    throw new Error(`Expected 2 showdown coefficients, got ${coefficients.length}`);
  }
  return (first + 1n) * coefficients[0]! + (second + 1n) * coefficients[1]!;
}

/**
 * Confirm the decrypted slots reproduce the account rows.
 * Bun uses the synchronous player library. The macOS app's player command
 * only completes asynchronously, so the WebView awaits that command.
 */
async function sealAccountMatchingCoefficients(
  data: Uint8Array,
  coefficients: readonly bigint[],
): Promise<SealedShowdownAccount> {
  try {
    return casinoSealAccount(data, coefficients);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not synchronous|not available/i.test(message)) throw err;
  }
  const invoke = (globalThis as {
    window?: { zero?: { invoke?: (command: string, payload?: unknown) => unknown } };
  }).window?.zero?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('player calc bridge is not available');
  }
  const result = await invoke('player', {
    op: 'calc',
    fn: 'sealAccount',
    kind: 0,
    variant: 0,
    data: Buffer.from(data).toString('hex'),
    coefficients: coefficients.map((value) => value.toString()),
  }) as { ok?: boolean; error?: string; written?: boolean; commitment?: string };
  if (!result || result.ok === false) {
    throw new Error(typeof result?.error === 'string' ? result.error : 'sealAccount failed');
  }
  if (result.written !== true || result.commitment == null) {
    throw new Error('Seal account rows are not written');
  }
  return {
    ...decodeSealAccount(data),
    coefficientCommitment: BigInt(result.commitment),
  };
}

/**
 * Decrypt the two sealed coefficients. libzkcasino checks that they produce
 * the rows Arcis revealed. Unused account slots are not coefficients.
 */
export async function openSealedShowdown(
  playerKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  sealed: SealedShowdownAccount,
): Promise<{ coefficients: bigint[]; coefficientCommitment: bigint }> {
  if (sealed.nActive !== 2) {
    throw new Error(`Seal account must hold 2 coefficients, got ${sealed.nActive}`);
  }
  const coefficients = await decryptSealedCoefficients(
    playerKey,
    mxePublicKey,
    sealed.coefficientsCiphertext,
    sealed.nonce,
  );
  const checked = await sealAccountMatchingCoefficients(sealed.data, coefficients);
  if (checked.coefficientCommitment === undefined) {
    throw new Error('Seal account rows are not written');
  }
  return { coefficients, coefficientCommitment: checked.coefficientCommitment };
}

/**
 * Decrypt Arcis-sealed showdown coefficients.
 *
 * Each slot is its own `Enc<Shared, u128>`. Slot `i` uses `nonce + i`.
 * A seal always holds two coefficients. The rest of the account slots are empty.
 */
export async function decryptSealedCoefficients(
  playerKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  ciphertexts: Uint8Array[],
  nonce: bigint,
): Promise<bigint[]> {
  if (ciphertexts.length !== SEAL_SLOTS) {
    throw new Error(
      `Expected ${SEAL_SLOTS} sealed coefficient ciphertexts, got ${ciphertexts.length}`,
    );
  }
  const cipher = sharedCipher(playerKey, mxePublicKey);
  const coeffs: bigint[] = [];
  for (let slot = 0; slot < 2; slot++) {
    const ciphertext = ciphertexts[slot];
    if (!ciphertext || ciphertext.length !== 32 || ciphertext.every((byte) => byte === 0)) {
      throw new Error(`seal coefficient ${slot} ciphertext is empty`);
    }
    const decrypted = cipher.decrypt([Array.from(ciphertext)], nonceToBytes(nonce + BigInt(slot)));
    if (decrypted.length !== 1) {
      throw new Error(
        `Expected 1 decrypted coefficient for slot ${slot}, got ${decrypted.length}`,
      );
    }
    coeffs.push(BigInt(decrypted[0]!));
  }
  return coeffs;
}

/**
 * Encrypt winner bitmasks under the same Shared key used for sealed coefficients.
 *
 * Required for fused `compute_pots` / `distribute_and_settle`: Arcis decrypts
 * these masks with Rescue, folds with PDA sealed coeffs, and pays only if the
 * poly hash matches the Groth16-latched `showdown_hash`.
 */
export async function encryptWinnerMasksWithSealedKey(
  playerKey: TableEncryptionKey,
  provider: AnchorProvider,
  programId: PublicKey,
  winnerMasks: bigint[],
): Promise<{ ciphertexts: Uint8Array[]; encryptionPubkey: Uint8Array; nonce: bigint }> {
  if (winnerMasks.length !== 9) {
    throw new Error('Expected 9 winner masks');
  }
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programId);
  // Match bet-encryption / Arcis: LE u128 nonce via @arcium-hq/client helpers.
  // `Enc<Shared, [u64; 9]>` is one Rescue stream over the array (batch encrypt).
  const nonce = deserializeLE(randomBytes(16));
  const nonceBytes = serializeLE(nonce, 16);
  const cipher = sharedCipher(playerKey, mxePublicKey);
  const encrypted = cipher.encrypt(winnerMasks, nonceBytes);
  const ciphertexts = encrypted.map((ct) =>
    ct instanceof Uint8Array ? ct : new Uint8Array(ct),
  );
  return {
    ciphertexts,
    encryptionPubkey: playerKey.publicKey,
    nonce,
  };
}

/**
 * Bits `0..numPlayers` of a winner bitmask (matches Arcis / pot.rs).
 */
export function activeWinnerMask(mask: bigint, numPlayers: number): bigint {
  if (numPlayers <= 0) return 0n;
  if (numPlayers >= 64) return mask;
  return mask & ((1n << BigInt(numPlayers)) - 1n);
}

/** One past the largest roulette payout multiplier (straight-up 35). */
export const ROULETTE_MULTIPLIER_BASE = 36n;
export const ROULETTE_BET_SLOTS = 12;

/**
 * One coefficient for the 12 roulette bet multipliers.
 * `m0 + m1 * 36 + ... + m11 * 36^11`.
 */
export function packRouletteMultipliers(payouts: readonly bigint[]): bigint {
  if (payouts.length !== ROULETTE_BET_SLOTS) {
    throw new Error(`Expected ${ROULETTE_BET_SLOTS} roulette multipliers, got ${payouts.length}`);
  }
  let packed = 0n;
  let place = 1n;
  for (const payout of payouts) {
    if (payout < 0n || payout >= ROULETTE_MULTIPLIER_BASE) {
      throw new Error(`roulette multiplier ${payout} does not fit in base ${ROULETTE_MULTIPLIER_BASE}`);
    }
    packed += payout * place;
    place *= ROULETTE_MULTIPLIER_BASE;
  }
  return packed;
}

/** One past the largest craps profit code (30:1 pays 901). */
export const CRAPS_MULTIPLIER_BASE = 1024n;
export const CRAPS_BET_SLOTS = 12;

/**
 * One coefficient for the 12 craps bet multipliers.
 * `m0 + m1 * 1024 + ... + m11 * 1024^11`.
 */
export function packCrapsMultipliers(payouts: readonly bigint[]): bigint {
  if (payouts.length !== CRAPS_BET_SLOTS) {
    throw new Error(`Expected ${CRAPS_BET_SLOTS} craps multipliers, got ${payouts.length}`);
  }
  let packed = 0n;
  let place = 1n;
  for (const payout of payouts) {
    if (payout < 0n || payout >= CRAPS_MULTIPLIER_BASE) {
      throw new Error(`craps multiplier ${payout} does not fit in base ${CRAPS_MULTIPLIER_BASE}`);
    }
    packed += payout * place;
    place *= CRAPS_MULTIPLIER_BASE;
  }
  return packed;
}

/** Above the largest 10-bit winner mask. */
export const POKER_WINNER_MASK_BASE = 1024n;

/**
 * One coefficient for nine pot winner masks.
 * `mask0 + mask1 * 1024 + ... + mask8 * 1024^8`.
 */
export function packPokerWinnerMasks(masks: readonly bigint[]): bigint {
  if (masks.length !== 9) {
    throw new Error(`Expected 9 winner masks, got ${masks.length}`);
  }
  let packed = 0n;
  let place = 1n;
  for (const mask of masks) {
    if (mask < 0n || mask >= POKER_WINNER_MASK_BASE) {
      throw new Error(`winner mask ${mask} does not fit in 10 bits`);
    }
    packed += mask * place;
    place *= POKER_WINNER_MASK_BASE;
  }
  return packed;
}

/**
 * Polynomial hash of the packed winner masks.
 *
 * `(packed + 1) * c0 + c1`. `packed` places each active mask at 1024^i.
 * Active masks keep bits `0..numPlayers`. The packed value is below 2^90
 * and each coefficient is below 2^128, so the product is below 2^219.
 * BN254 and BaseField25519 agree without reduction.
 *
 * Coefficients MUST come from the Arcis pair seal (player-decrypted).
 * Do NOT use HASH_COEFFS_900 — that table is for share/deck hashing only.
 *
 * `numPlayers` defaults to 10 (max table size). Pass the hand size for Arcis parity.
 */
export function computeWinnerMaskHash(
  winnerMasks: bigint[],
  coefficients: bigint[],
  numPlayers = 10,
): bigint {
  if (coefficients.length !== 2) {
    throw new Error(`Expected 2 sealed coefficients, got ${coefficients.length}`);
  }
  const packed = packPokerWinnerMasks(
    winnerMasks.map((mask) => activeWinnerMask(mask, numPlayers)),
  );
  return (packed + 1n) * coefficients[0]! + coefficients[1]!;
}

/**
 * Serialize showdown poly-hash as 32-byte big-endian (Groth16 / on-chain latch).
 *
 * Matches `fieldToBytesBE` used by `finalize_showdown`. Arcis then reverses to
 * LE u128 halves for BaseField25519 compare.
 */
export function hashToBytes(hash: bigint): Uint8Array {
  if (hash < 0n) throw new Error(`hash must be non-negative: ${hash}`);
  const bytes = new Uint8Array(32);
  let v = hash;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`hash exceeds 32 bytes: ${hash}`);
  return bytes;
}

/** Encode one winner index as the player-index bitmask used by Groth16. */
export function encodeWinnerMask(winnerIndex: number): bigint {
  if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex > 9) {
    throw new Error('Winner index must be an integer from 0 to 9');
  }
  return 1n << BigInt(winnerIndex);
}

/** Create a full set of 9 winner masks (one winner per pot). */
export function createWinnerMasks(winners: number[]): bigint[] {
  if (winners.length !== 9) {
    throw new Error('Expected 9 pot winners');
  }
  return winners.map(encodeWinnerMask);
}

export { getMXEPublicKeyWithRetry };
