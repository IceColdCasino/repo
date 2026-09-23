/** Max Poseidon inputs (Solana `sol_poseidon` syscall limit). */
export const POSEIDON_CHUNK_SIZE = 12;
/** Every Circom hierarchy node accepts at most 12 inputs. */
export const MAX_POSEIDON_INPUTS = POSEIDON_CHUNK_SIZE;

function combineChunkHashes(
  chunkHashes: bigint[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  if (chunkHashes.length === 0) {
    throw new Error('combineChunkHashes requires at least one value');
  }
  if (chunkHashes.length <= MAX_POSEIDON_INPUTS) {
    return poseidon(chunkHashes);
  }

  const nLevel2 = Math.ceil(chunkHashes.length / POSEIDON_CHUNK_SIZE);
  const level2: bigint[] = [];
  for (let c = 0; c < nLevel2; c++) {
    const start = c * POSEIDON_CHUNK_SIZE;
    level2.push(
      poseidon(chunkHashes.slice(start, start + Math.min(POSEIDON_CHUNK_SIZE, chunkHashes.length - start))),
    );
  }
  return combineChunkHashes(level2, poseidon);
}

/** Row-major flatten + chunk-at-12 + hierarchical combine when chunk count > 16. */
export function hashFlatValues(
  flat: bigint[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  const totalValues = flat.length;
  if (totalValues === 0) {
    throw new Error('hashFlatValues requires at least one value');
  }

  const nChunks = Math.ceil(totalValues / POSEIDON_CHUNK_SIZE);
  const chunkHashes: bigint[] = [];
  for (let c = 0; c < nChunks; c++) {
    const start = c * POSEIDON_CHUNK_SIZE;
    chunkHashes.push(
      poseidon(flat.slice(start, start + Math.min(POSEIDON_CHUNK_SIZE, totalValues - start))),
    );
  }

  return combineChunkHashes(chunkHashes, poseidon);
}

/** Hash permutation-matrix row values (matches `HashRowValueChunk` in circuits/shuffle.circom). */
export function hashRowValues(
  rowValues: bigint[],
  poseidon: (inputs: bigint[]) => bigint,
): bigint {
  if (rowValues.length <= MAX_POSEIDON_INPUTS) {
    return poseidon(rowValues);
  }

  const nChunks = Math.ceil(rowValues.length / POSEIDON_CHUNK_SIZE);
  const chunkHashes: bigint[] = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * POSEIDON_CHUNK_SIZE;
    chunkHashes.push(
      poseidon(rowValues.slice(start, start + Math.min(POSEIDON_CHUNK_SIZE, rowValues.length - start))),
    );
  }

  return combineChunkHashes(chunkHashes, poseidon);
}
