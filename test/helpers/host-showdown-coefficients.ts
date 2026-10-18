/**
 * Deterministic stand-in for an Arcis showdown seal: two coefficients,
 * each below 2^128 with bit 127 set.
 */
export function hostShowdownCoefficients(): bigint[] {
  return [(1n << 127n) + 1n, (1n << 127n) + 2n];
}
