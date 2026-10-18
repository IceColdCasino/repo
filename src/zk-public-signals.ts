/** hashout circuits expose [outputHash, inputHash] as public signals. */
export function extractHashoutSignals(publicSignals: string[]): {
  outputHash: bigint;
  inputHash: bigint;
} {
  if (publicSignals.length < 2) {
    throw new Error('Expected at least two public signals for hashout circuit');
  }
  const outputHash = BigInt(publicSignals[0]!);
  const inputHash = BigInt(publicSignals[1]!);
  return { outputHash, inputHash };
}

/** shuffle_1_deck_52_main: deck fields, then permutationHash, then inputHash. */
export function extractShuffleSignals(publicSignals: string[]): {
  inputHash: bigint;
  permutationHash: bigint;
} {
  if (publicSignals.length < 2) {
    throw new Error('Expected shuffle public signals');
  }
  const signals = publicSignals.map((s) => BigInt(s));
  const inputHash = signals[signals.length - 1]!;
  const permutationHash = signals[signals.length - 2]!;
  return { inputHash, permutationHash };
}
