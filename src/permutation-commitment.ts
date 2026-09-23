import { PlayerEngine } from './player-ffi';
import { POSEIDON_CHUNK_SIZE } from './poseidon-chunk';

type BabyJubRandom = {
  F: { toObject: (x: unknown) => bigint; random: () => unknown };
};

/**
 * Generates a derangement (permutation with no fixed points)
 * Uses rejection sampling: keep generating until we get one with no fixed points
 */
function generateDerangement(babyjub: BabyJubRandom, n: number): number[] {
  let array: number[];
  let attempts = 0;
  const maxAttempts = 1000;
  
  do {
    array = [...Array(n).keys()];
    let currentIndex = array.length - 1;

    while (currentIndex !== 0) {
      const randomIndex = Number(
        babyjub.F.toObject(babyjub.F.random()) % BigInt(currentIndex + 1)
      );
      [array[currentIndex]!, array[randomIndex]!] = [array[randomIndex]!, array[currentIndex]!];
      currentIndex--;
    }
    
    attempts++;
    if (attempts > maxAttempts) {
      throw new Error(`Failed to generate derangement after ${maxAttempts} attempts`);
    }
  } while (array.some((val, idx) => val === idx)); // Reject if any fixed points
  
  return array;
}

/**
 * Samples a nxn permutation matrix using Fisher-Yates shuffle
 * Ensures NO fixed points (every card moves from original position)
 * Uses ffjavascript's random scalar generation
 */
export function generatePermutationMatrix(babyjub: BabyJubRandom, n: number): bigint[] {
  // Generate a derangement (no fixed points)
  const array = generateDerangement(babyjub, n);

  const matrix: bigint[] = new Array(n * n).fill(0n);
  for (let i = 0; i < n; i++) {
    matrix[i * n + array[i]!] = 1n;
  }

  return matrix;
}

/**
 * Generate an identity permutation matrix (for testing rejection)
 * P[i][i] = 1 for all i, all other entries are 0
 */
export function generateIdentityMatrix(n: number): bigint[] {
  const matrix: bigint[] = new Array(n * n).fill(0n);
  for (let i = 0; i < n; i++) {
    matrix[i * n + i] = 1n;
  }
  return matrix;
}

export async function commitToPermutation(P: bigint[]): Promise<string> {
  const engine = new PlayerEngine();
  const poseidon = (inputs: bigint[]) => engine.poseidonHash(inputs);

  // Hash in chunks of 12, then hash chunk hashes (hierarchical when > 12)
  const chunkSize = POSEIDON_CHUNK_SIZE;
  const nChunks = Math.ceil(P.length / chunkSize);

  const chunkHashes: bigint[] = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, P.length);
    const chunk = P.slice(start, end);
    chunkHashes.push(poseidon(chunk));
  }

  // Hash all chunk hashes together in chunks of 12 again if needed
  let hashes = chunkHashes;
  while (hashes.length > 1) {
    const nextHashes: bigint[] = [];
    for (let i = 0; i < hashes.length; i += chunkSize) {
      const chunk = hashes.slice(i, i + chunkSize);
      if (chunk.length === 1) {
        nextHashes.push(chunk[0]!);
      } else {
        nextHashes.push(poseidon(chunk));
      }
    }
    hashes = nextHashes;
  }

  return hashes[0]!.toString();
}

export async function verifyCommitment(P: bigint[], commitment: string): Promise<boolean> {
  const computed = await commitToPermutation(P);
  return computed === commitment;
}

export function revealPermutation(P: bigint[]): bigint[] {
  return P;
}
