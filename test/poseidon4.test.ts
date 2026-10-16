import { describe, expect, test } from 'bun:test';
import { poseidon4, sumPoseidon4Groups } from '../src/poseidon4';

describe('poseidon4', () => {
  test('matches circomlib Poseidon(4)', () => {
    expect(poseidon4([1n, 2n, 3n, 4n])).toBe(
      0x299c867db6c1fdd79dcefa40e4510b9837e60ebb1ce0663dbaa525df65250465n,
    );
    expect(poseidon4([0n, 0n, 0n, 0n])).toBe(
      0x0532fd436e19c70e51209694d9c215250937921b8b79060488c1206db73e9946n,
    );
  });

  test('sums 4-limb groups modulo 2^256', () => {
    const groups = [
      [1n, 2n, 3n, 4n],
      [0n, 0n, 0n, 0n],
    ];
    const sum = sumPoseidon4Groups(groups);
    const mod = (1n << 256n) - 1n;
    expect(sum).toBe((poseidon4(groups[0]!) + poseidon4(groups[1]!)) & mod);
  });
});
