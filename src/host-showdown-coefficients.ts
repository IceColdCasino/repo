import { casinoFr } from './casino-calc';

/** Slots in an Arcis showdown seal. Each game's polynomial uses the first terms. */
export const SEAL_SLOTS = 14;

const SEAL_TOP_BIT = 1n << 127n;
const SEAL_LIMIT = 1n << 128n;

/** Host-sealed showdown coefficients: 14 values below 2^128 with bit 127 set. */
export function requireHostShowdownCoefficients(coeffs: readonly bigint[] | undefined): bigint[] {
  if (!coeffs || coeffs.length !== SEAL_SLOTS) {
    throw new Error(
      `showdown coefficients must come from the host (expected ${SEAL_SLOTS}, got ${coeffs?.length ?? 0})`,
    );
  }
  if (coeffs.some((value) => value < SEAL_TOP_BIT || value >= SEAL_LIMIT)) {
    throw new Error('Host showdown coefficient must be below 2^128 with bit 127 set');
  }
  return [...coeffs];
}

/**
 * Poseidon of the four subset sums Arcis reveals on the seal account
 * (`showdown_seal.circom`). Light reads the same rows.
 */
export function sealCommitment(coeffs: readonly bigint[]): bigint {
  return casinoFr(0, 'sealCommitment', { coefficients: requireHostShowdownCoefficients(coeffs) });
}

/**
 * The public hash already includes this commitment. The witness carries the
 * live coefficients. The commitment weights the first two slots.
 */
export function sealedShowdownWitness(hash: bigint, coeffs: readonly bigint[], nTerms: number) {
  const full = requireHostShowdownCoefficients(coeffs);
  if (nTerms < 1 || nTerms > SEAL_SLOTS) {
    throw new Error(`showdown term count must be 1..${SEAL_SLOTS}, got ${nTerms}`);
  }
  return {
    hash,
    sealCommitment: sealCommitment(full).toString(),
    coefficients: full.slice(0, nTerms).map((c) => c.toString()),
  };
}
