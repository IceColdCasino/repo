/** Deterministic stand-in for host-sealed showdown coefficients in offline tests. */
export function hostShowdownCoefficients(count: number): bigint[] {
  return Array.from({ length: count }, (_, i) => BigInt(i + 1));
}
