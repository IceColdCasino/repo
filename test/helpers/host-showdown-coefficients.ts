import { SEAL_SLOTS } from '../../src/host-showdown-coefficients';

/**
 * Deterministic stand-in for an Arcis showdown seal. The first `nLive` slots
 * have a distinct low limb. The rest are the public constant 2^127.
 */
export function hostShowdownCoefficients(nLive: number): bigint[] {
  if (nLive < 1 || nLive > SEAL_SLOTS) {
    throw new Error(`showdown seal live count must be 1..${SEAL_SLOTS}, got ${nLive}`);
  }
  return Array.from({ length: SEAL_SLOTS }, (_, i) =>
    i < nLive ? (1n << 127n) + BigInt(i + 1) : 1n << 127n,
  );
}
