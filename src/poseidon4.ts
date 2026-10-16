import { BN254_N0, BN254_P, BN254_R2, POSEIDON4_C, POSEIDON4_M, POSEIDON4_P, POSEIDON4_S } from './poseidon4-consts';

/** Circomlib Poseidon with 4 inputs (state width 5) over BN254 Fr. */
const TWO_64 = 1n << 64n;
const MASK64 = TWO_64 - 1n;
const T = 5;
const N_ROUNDS_F = 8;
const N_ROUNDS_P = 60;

type Limb4 = bigint[];

function mac(acc: bigint, a: bigint, b: bigint, carry: bigint): [bigint, bigint] {
  const sum = acc + a * b + carry;
  return [sum & MASK64, sum >> 64n];
}

function montMul(a: Limb4, b: Limb4): Limb4 {
  let t = [0n, 0n, 0n, 0n, 0n];
  for (let i = 0; i < 4; i++) {
    let carry = 0n;
    const nt = [0n, 0n, 0n, 0n];
    for (let j = 0; j < 4; j++) {
      const [lo, hi] = mac(t[j]!, a[i]!, b[j]!, carry);
      nt[j] = lo;
      carry = hi;
    }
    t = [nt[0]!, nt[1]!, nt[2]!, nt[3]!, carry];
    const m = (t[0]! * BN254_N0) & MASK64;
    carry = 0n;
    for (let j = 0; j < 4; j++) {
      const [lo, hi] = mac(t[j]!, m, BN254_P[j]!, carry);
      nt[j] = lo;
      carry = hi;
    }
    const extra = t[4]! + carry;
    t = [nt[1]!, nt[2]!, nt[3]!, extra, 0n];
  }
  const limbs = t.slice(0, 4);
  let borrow = 0n;
  const diff = [0n, 0n, 0n, 0n];
  for (let i = 0; i < 4; i++) {
    const v = limbs[i]! - BN254_P[i]! - borrow;
    if (v < 0n) {
      diff[i] = v + TWO_64;
      borrow = 1n;
    } else {
      diff[i] = v;
      borrow = 0n;
    }
  }
  return borrow === 0n ? diff : limbs;
}

function toLimbs(x: bigint): Limb4 {
  return [x & MASK64, (x >> 64n) & MASK64, (x >> 128n) & MASK64, (x >> 192n) & MASK64];
}

function fromLimbs(l: Limb4): bigint {
  return l[0]! + (l[1]! << 64n) + (l[2]! << 128n) + (l[3]! << 192n);
}

function toMont(x: bigint): Limb4 {
  return montMul(toLimbs(x), BN254_R2);
}

function fromMont(l: Limb4): bigint {
  return fromLimbs(montMul(l, [1n, 0n, 0n, 0n]));
}

function feAdd(a: Limb4, b: Limb4): Limb4 {
  const c = [0n, 0n, 0n, 0n];
  let carry = 0n;
  for (let i = 0; i < 4; i++) {
    const sum = a[i]! + b[i]! + carry;
    c[i] = sum & MASK64;
    carry = sum >> 64n;
  }
  let borrow = 0n;
  const diff = [0n, 0n, 0n, 0n];
  for (let i = 0; i < 4; i++) {
    const v = c[i]! - BN254_P[i]! - borrow;
    if (v < 0n) {
      diff[i] = v + TWO_64;
      borrow = 1n;
    } else {
      diff[i] = v;
      borrow = 0n;
    }
  }
  return borrow === 0n ? diff : c;
}

function fePow5(x: Limb4): Limb4 {
  const x2 = montMul(x, x);
  const x4 = montMul(x2, x2);
  return montMul(x4, x);
}

function feMix(state: Limb4[], table: Limb4[]): Limb4[] {
  const out: Limb4[] = [];
  for (let i = 0; i < T; i++) {
    let acc = [0n, 0n, 0n, 0n];
    for (let j = 0; j < T; j++) {
      acc = feAdd(acc, montMul(table[i * T + j]!, state[j]!));
    }
    out.push(acc);
  }
  return out;
}

const ZERO: Limb4 = [0n, 0n, 0n, 0n];

/** Poseidon(4) of four BN254 field elements. Output is the normal-form field element. */
export function poseidon4(inputs: readonly bigint[]): bigint {
  if (inputs.length !== 4) {
    throw new Error(`poseidon4 expects 4 inputs, got ${inputs.length}`);
  }
  let state: Limb4[] = [ZERO, ...inputs.map((x) => toMont(x))];
  for (let i = 0; i < T; i++) state[i] = feAdd(state[i]!, POSEIDON4_C[i]!);
  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    for (let i = 0; i < T; i++) {
      state[i] = feAdd(fePow5(state[i]!), POSEIDON4_C[(r + 1) * T + i]!);
    }
    state = feMix(state, POSEIDON4_M);
  }
  for (let i = 0; i < T; i++) {
    state[i] = feAdd(fePow5(state[i]!), POSEIDON4_C[(N_ROUNDS_F / 2) * T + i]!);
  }
  state = feMix(state, POSEIDON4_P);
  for (let r = 0; r < N_ROUNDS_P; r++) {
    state[0] = feAdd(fePow5(state[0]!), POSEIDON4_C[(N_ROUNDS_F / 2 + 1) * T + r]!);
    let s0 = ZERO;
    for (let i = 0; i < T; i++) {
      s0 = feAdd(s0, montMul(POSEIDON4_S[(T * 2 - 1) * r + i]!, state[i]!));
    }
    const old0 = state[0]!;
    for (let i = 1; i < T; i++) {
      state[i] = feAdd(state[i]!, montMul(old0, POSEIDON4_S[(T * 2 - 1) * r + T + i - 1]!));
    }
    state[0] = s0;
  }
  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    for (let i = 0; i < T; i++) {
      state[i] = feAdd(
        fePow5(state[i]!),
        POSEIDON4_C[(N_ROUNDS_F / 2 + 1) * T + N_ROUNDS_P + r * T + i]!,
      );
    }
    state = feMix(state, POSEIDON4_M);
  }
  for (let i = 0; i < T; i++) state[i] = fePow5(state[i]!);
  state = feMix(state, POSEIDON4_M);
  return fromMont(state[0]!);
}

const MOD_256 = 1n << 256n;

/**
 * Wrapping sum of Poseidon(4) over every 4-limb group.
 * Each Arcis share-verify job contributes one group.
 */
export function sumPoseidon4Groups(groups: readonly (readonly bigint[])[]): bigint {
  let acc = 0n;
  for (const group of groups) {
    acc = (acc + poseidon4(group)) & (MOD_256 - 1n);
  }
  return acc;
}
