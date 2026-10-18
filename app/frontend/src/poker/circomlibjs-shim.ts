/** Production native bundle stub — player crypto runs in Zig, not circomlibjs. */

export async function buildBabyjub(): Promise<never> {
  throw new Error('circomlibjs is not used in the native app');
}

export async function buildPoseidon(): Promise<never> {
  throw new Error('circomlibjs is not used in the native app');
}
