export function requireHostShowdownCoefficients(
  coeffs: readonly bigint[] | undefined,
  count: number,
): bigint[] {
  if (!coeffs || coeffs.length !== count) {
    throw new Error(
      `showdown coefficients must come from the host (expected ${count}, got ${coeffs?.length ?? 0})`,
    );
  }
  if (coeffs.some((value) => value === 0n)) {
    throw new Error('Host showdown coefficient must be non-zero');
  }
  return [...coeffs];
}
