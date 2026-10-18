import { extractShuffleSignals } from '@poker-src/zk-public-signals';

export { extractShuffleSignals } from '@poker-src/zk-public-signals';

export interface ShuffleReceiptPayload {
  phase: number;
  playerIndex: number;
  outputHash: string;
}

function bigintToHex32(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

export function buildShuffleReceiptPayload(
  playerIndex: number,
  _publicSignals: string[],
  permutationHash: bigint,
): ShuffleReceiptPayload {
  return {
    phase: 1,
    playerIndex,
    outputHash: bigintToHex32(permutationHash),
  };
}
