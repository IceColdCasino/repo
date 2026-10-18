import { casinoFr } from './casino-calc';

/** Ciphertext slots stored on the seal account. Only the first two are coefficients. */
export const SEAL_SLOTS = 14;

/** Every showdown polynomial uses these two host-sealed coefficients. */
export const LIVE_COEFFICIENTS = 2;

const SEAL_TOP_BIT = 1n << 127n;
const SEAL_LIMIT = 1n << 128n;

/** The two host-sealed showdown coefficients, each below 2^128 with bit 127 set. */
export function requireHostShowdownCoefficients(coeffs: readonly bigint[] | undefined): bigint[] {
  if (!coeffs || coeffs.length !== LIVE_COEFFICIENTS) {
    throw new Error(
      `showdown coefficients must come from the host (expected ${LIVE_COEFFICIENTS}, got ${coeffs?.length ?? 0})`,
    );
  }
  if (coeffs.some((value) => value < SEAL_TOP_BIT || value >= SEAL_LIMIT)) {
    throw new Error('Host showdown coefficient must be below 2^128 with bit 127 set');
  }
  return [...coeffs];
}

/** Account layout: the two coefficients, then unused slots at 2^127. */
export function sealAccountSlots(coeffs: readonly bigint[]): bigint[] {
  const live = requireHostShowdownCoefficients(coeffs);
  while (live.length < SEAL_SLOTS) live.push(SEAL_TOP_BIT);
  return live;
}

/**
 * Poseidon of the four subset sums Arcis reveals on the seal account
 * (`showdown_seal.circom`). Light reads the same rows. Only the two
 * coefficients are weighted.
 */
export function sealCommitment(coeffs: readonly bigint[]): bigint {
  return casinoFr(0, 'sealCommitment', { coefficients: sealAccountSlots(coeffs) });
}

/**
 * The public hash already includes this commitment. The witness carries
 * the two coefficients.
 */
export function sealedShowdownWitness(hash: bigint, coeffs: readonly bigint[]) {
  const live = requireHostShowdownCoefficients(coeffs);
  return {
    hash,
    sealCommitment: sealCommitment(live).toString(),
    coefficients: live.map((c) => c.toString()),
  };
}
