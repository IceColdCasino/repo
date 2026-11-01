/**
 * WebView player math. The native app proves in Zig; vitest and a bridge-less
 * WebView use circomlibjs so shuffle, share, and decrypt still run.
 */
import { buildBabyjub, buildPoseidon, type BabyJub, type Poseidon } from 'circomlibjs';

const babyjub: BabyJub = await buildBabyjub();
const poseidon: Poseidon = await buildPoseidon();

function scalar253(): bigint {
  const max = 1n << 253n;
  for (;;) {
    const r = babyjub.F.toObject(babyjub.F.random()) as bigint;
    if (r > 0n && r < max) return r;
  }
}

function generateShufflePermutation(n: number): bigint[] {
  const order = Array.from({ length: n }, (_, index) => index);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Number(scalar253() % BigInt(i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  const matrix: bigint[] = [];
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      matrix.push(order[row] === col ? 1n : 0n);
    }
  }
  return matrix;
}

export function playerFfiAvailable(): boolean {
  return true;
}

export function requirePlayerFfi(): void {}

export function shouldUsePlayerFfi(): boolean {
  return false;
}

export class PlayerEngine {
  asBabyJub(): BabyJub {
    return babyjub;
  }

  asPoseidon(): Poseidon {
    return poseidon;
  }

  generateShufflePermutation(n: number): bigint[] {
    return generateShufflePermutation(n);
  }

  scalar253(): bigint {
    return scalar253();
  }
}
