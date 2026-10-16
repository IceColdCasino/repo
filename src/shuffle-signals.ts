/**
 * Shuffle proofs publish two hashes, then the public input hash.
 * Circom order is outputs first: [deckHash, permutationHash, inputHash].
 * The shoe itself is returned beside the proof, not inside it.
 */
export const SHUFFLE_PROOF_PUBLIC_SIGNALS = 3;

export interface ShuffleProofSignals {
  outputDeckHash: bigint;
  permutationHash: bigint;
  inputHash: bigint;
}

export function readShuffleProof(
  publicSignals: Array<bigint | string>,
): ShuffleProofSignals {
  const signals = publicSignals.map((signal) => BigInt(signal));
  if (signals.length !== SHUFFLE_PROOF_PUBLIC_SIGNALS) {
    throw new Error(
      `shuffle proof publishes 2 hashes, got ${signals.length} public signals`,
    );
  }
  return {
    outputDeckHash: signals[0]!,
    permutationHash: signals[1]!,
    inputHash: signals[2]!,
  };
}
