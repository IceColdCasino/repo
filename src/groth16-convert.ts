/**
 * Convert snarkjs / rapidsnark Groth16 proofs and public signals into the
 * byte layout consumed by the on-chain `light-casino` verifier
 * (`groth16_verify::UncompressedProof`, backed by `groth16-solana 0.2.0`).
 *
 * Why this module exists
 * ----------------------
 * snarkjs emits proof coordinates as decimal strings in *affine projective*
 * form (each G1/G2 point is `[x, y, z]` with `z == "1"`), and G2 field
 * elements in `[c0, c1]` ordering. The on-chain verifier expects:
 *
 *   - G1 points as 64 big-endian bytes: `x[32] || y[32]`.
 *   - G2 points as 128 big-endian bytes: `x_c1[32] || x_c0[32] || y_c1[32] || y_c0[32]`.
 *     (arkworks / groth16-solana use the [c1, c0] ordering, the reverse of
 *      snarkjs's [c0, c1].)
 *   - Public inputs as 32 big-endian bytes each.
 *
 * proof_a is passed *non-negated*; the on-chain program negates it (the
 * groth16-solana verifier convention) so no curve arithmetic is needed here.
 */

import type { Groth16Proof } from 'snarkjs';

/** BN254 scalar field. Circom reduces signals modulo this prime. */
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Encode a decimal/bigint field element as 32 big-endian bytes. */
export function fieldToBytesBE(value: string | bigint): number[] {
  let v = BigInt(value);
  if (v < 0n) throw new Error(`field element must be non-negative: ${value}`);
  const out = new Array<number>(32).fill(0);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`field element exceeds 32 bytes: ${value}`);
  return out;
}

/**
 * Canonical scalar bytes. A value at or above the scalar field is reduced the
 * same way a circom signal is, so Poseidon and Groth16 see the same integer
 * the prover used.
 */
export function frToBytesBE(value: string | bigint): number[] {
  let v = BigInt(value);
  if (v < 0n) throw new Error(`field element must be non-negative: ${value}`);
  if (v >= BN254_FR) {
    console.log(`[fr] reduced scalar above the field (high byte 0x${(v >> 248n).toString(16)})`);
    v %= BN254_FR;
  }
  return fieldToBytesBE(v);
}

/** The on-chain proof byte layout. */
export interface OnchainProof {
  a: number[]; // 64 bytes
  b: number[]; // 128 bytes
  c: number[]; // 64 bytes
}

/**
 * Convert a snarkjs Groth16 proof to the on-chain uncompressed byte layout.
 *
 * Handles both snarkjs `[x, y, z]` projective points and already-affine
 * `[x, y]` points (z assumed 1).
 */
export function proofToBytes(proof: Groth16Proof): OnchainProof {
  const piA = proof.pi_a as string[];
  const piB = proof.pi_b as string[][];
  const piC = proof.pi_c as string[];

  // G1: x || y (big-endian).
  const a = [...fieldToBytesBE(piA[0]!), ...fieldToBytesBE(piA[1]!)];

  // G2: snarkjs gives [[x_c0, x_c1], [y_c0, y_c1], [z_c0, z_c1]].
  // arkworks / groth16-solana want x_c1 || x_c0 || y_c1 || y_c0.
  const b = [
    ...fieldToBytesBE(piB[0]![1]!), // x_c1
    ...fieldToBytesBE(piB[0]![0]!), // x_c0
    ...fieldToBytesBE(piB[1]![1]!), // y_c1
    ...fieldToBytesBE(piB[1]![0]!), // y_c0
  ];

  // G1: x || y (big-endian).
  const c = [...fieldToBytesBE(piC[0]!), ...fieldToBytesBE(piC[1]!)];

  if (a.length !== 64) throw new Error(`proof.a must be 64 bytes, got ${a.length}`);
  if (b.length !== 128) throw new Error(`proof.b must be 128 bytes, got ${b.length}`);
  if (c.length !== 64) throw new Error(`proof.c must be 64 bytes, got ${c.length}`);

  return {
    a: Array.from(new Uint8Array(a)),
    b: Array.from(new Uint8Array(b)),
    c: Array.from(new Uint8Array(c)),
  };
}

/**
 * Convert an array of public signals (decimal strings) to big-endian 32-byte
 * arrays, matching the on-chain verifier's expectation.
 */
export function publicSignalsToBytes(signals: Array<string | bigint>): number[][] {
  return signals.map((s) => frToBytesBE(s));
}
