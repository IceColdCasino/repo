/**
 * libzkcasino player-math FFI (Poseidon + BabyJub via rapidsnark libfr).
 * Used by complete_*_game_with_proofs and e2e Arcis hands for player calculations.
 * The e2e Arcis server remains Solana + Arcium — this module is client-side only.
 */
import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { BabyJub, Poseidon } from 'circomlibjs';

const libPath = path.join(
  import.meta.dir,
  `../libzkcasino/zig-out/lib/libzkcasino-player.${suffix}`,
);

const SYMBOLS = {
  zkplayer_create: { args: [FFIType.u64], returns: FFIType.ptr },
  zkplayer_free: { args: [FFIType.ptr], returns: FFIType.void },
  zkplayer_base8: { args: [FFIType.ptr], returns: FFIType.void },
  zkplayer_generator: { args: [FFIType.ptr], returns: FFIType.void },
  zkplayer_sub_order: { args: [FFIType.ptr], returns: FFIType.void },
  zkplayer_poseidon: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_add_point: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_mul_point: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_mul_base8: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_neg: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_random: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_in_curve: { args: [FFIType.ptr], returns: FFIType.i32 },
  zkplayer_decrypt: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_decrypt_card: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_catalog_lookup: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_decrypt_from_partials: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  zkplayer_derangement: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  zkplayer_shuffle_perm: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
} as const;

let lib: ReturnType<typeof dlopen<typeof SYMBOLS>> | undefined;
let required = false;

export function playerFfiAvailable(): boolean {
  return existsSync(libPath);
}

export function requirePlayerFfi(): void {
  if (!playerFfiAvailable()) {
    throw new Error(
      `libzkcasino-player not found at ${libPath}. Build it with: cd libzkcasino && zig build player-lib`,
    );
  }
  required = true;
}

export function shouldUsePlayerFfi(): boolean {
  if (process.env.ZK_PLAYER_FFI === '0') return false;
  if (required) return true;
  return playerFfiAvailable() && process.env.ZK_PLAYER_FFI === '1';
}

function getLib() {
  if (!lib) {
    if (!existsSync(libPath)) {
      throw new Error(`libzkcasino-player missing: ${libPath}`);
    }
    lib = dlopen(libPath, SYMBOLS);
  }
  return lib;
}

function toLimbs(n: bigint): BigUint64Array {
  let x = n < 0n ? -n : n;
  const out = new BigUint64Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = x & 0xffffffffffffffffn;
    x >>= 64n;
  }
  return out;
}

function fromLimbs(limbs: BigUint64Array, offset = 0): bigint {
  return limbs[offset]!
    | (limbs[offset + 1]! << 64n)
    | (limbs[offset + 2]! << 128n)
    | (limbs[offset + 3]! << 192n);
}

function ctLimbs(ct: readonly [bigint, bigint, bigint, bigint]): BigUint64Array {
  const out = new BigUint64Array(16);
  out.set(toLimbs(ct[0]), 0);
  out.set(toLimbs(ct[1]), 4);
  out.set(toLimbs(ct[2]), 8);
  out.set(toLimbs(ct[3]), 12);
  return out;
}

function pointLimbs(p: [bigint, bigint]): BigUint64Array {
  const out = new BigUint64Array(8);
  out.set(toLimbs(p[0]), 0);
  out.set(toLimbs(p[1]), 4);
  return out;
}

function fromPoint(limbs: BigUint64Array): [bigint, bigint] {
  return [fromLimbs(limbs, 0), fromLimbs(limbs, 4)];
}

function asBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  return BigInt(v as number);
}

export class PlayerEngine {
  #raw: ReturnType<typeof getLib>['symbols'];
  #ptr: ReturnType<ReturnType<typeof getLib>['symbols']['zkplayer_create']>;
  #base8: [bigint, bigint];
  #generator: [bigint, bigint];
  #subOrder: bigint;

  constructor(seed?: bigint) {
    const opened = getLib();
    this.#raw = opened.symbols;
    const seedU64 = seed !== undefined
      ? seed & 0xffffffffffffffffn
      : BigInt(crypto.getRandomValues(new Uint32Array(2))[0]!);
    this.#ptr = this.#raw.zkplayer_create(seedU64);
    if (!this.#ptr) throw new Error('zkplayer_create failed');

    const b8 = new BigUint64Array(8);
    const g = new BigUint64Array(8);
    const so = new BigUint64Array(4);
    this.#raw.zkplayer_base8(ptr(b8));
    this.#raw.zkplayer_generator(ptr(g));
    this.#raw.zkplayer_sub_order(ptr(so));
    this.#base8 = fromPoint(b8);
    this.#generator = fromPoint(g);
    this.#subOrder = fromLimbs(so);
  }

  free(): void {
    if (this.#ptr) {
      this.#raw.zkplayer_free(this.#ptr);
      this.#ptr = null;
    }
  }

  poseidonHash(inputs: bigint[]): bigint {
    if (inputs.length < 1 || inputs.length > 16) {
      throw new Error(`poseidon arity ${inputs.length} out of 1..16`);
    }
    const inLimbs = new BigUint64Array(inputs.length * 4);
    for (let i = 0; i < inputs.length; i++) {
      inLimbs.set(toLimbs(asBig(inputs[i])), i * 4);
    }
    const out = new BigUint64Array(4);
    if (this.#raw.zkplayer_poseidon(ptr(inLimbs), inputs.length, ptr(out)) !== 0) {
      throw new Error('zkplayer_poseidon failed');
    }
    return fromLimbs(out);
  }

  addPoint(a: [bigint, bigint], b: [bigint, bigint]): [bigint, bigint] {
    const out = new BigUint64Array(8);
    if (this.#raw.zkplayer_add_point(ptr(pointLimbs(a)), ptr(pointLimbs(b)), ptr(out)) !== 0) {
      throw new Error('zkplayer_add_point failed');
    }
    return fromPoint(out);
  }

  mulPoint(p: [bigint, bigint], k: bigint): [bigint, bigint] {
    const out = new BigUint64Array(8);
    if (this.#raw.zkplayer_mul_point(ptr(pointLimbs(p)), ptr(toLimbs(k)), ptr(out)) !== 0) {
      throw new Error('zkplayer_mul_point failed');
    }
    return fromPoint(out);
  }

  mulBase8(k: bigint): [bigint, bigint] {
    const out = new BigUint64Array(8);
    if (this.#raw.zkplayer_mul_base8(ptr(toLimbs(k)), ptr(out)) !== 0) {
      throw new Error('zkplayer_mul_base8 failed');
    }
    return fromPoint(out);
  }

  neg(a: bigint): bigint {
    const out = new BigUint64Array(4);
    if (this.#raw.zkplayer_neg(ptr(toLimbs(a)), ptr(out)) !== 0) {
      throw new Error('zkplayer_neg failed');
    }
    return fromLimbs(out);
  }

  random(): bigint {
    const out = new BigUint64Array(4);
    if (this.#raw.zkplayer_random(this.#ptr, ptr(out)) !== 0) {
      throw new Error('zkplayer_random failed');
    }
    return fromLimbs(out);
  }

  /** Non-zero Fr in `[1, 2^253)` — ElGamal circuits use `Num2Bits(253)`. */
  scalar253(): bigint {
    const max = 1n << 253n;
    for (;;) {
      const r = this.random();
      if (r > 0n && r < max) return r;
    }
  }

  decryptWithSk(sk: bigint, ct: readonly [bigint, bigint, bigint, bigint]): number {
    const out = new Int32Array(1);
    if (this.#raw.zkplayer_decrypt(this.#ptr, ptr(toLimbs(sk)), ptr(ctLimbs(ct)), ptr(out)) !== 0) {
      throw new Error('zkplayer_decrypt failed');
    }
    return out[0]!;
  }

  decryptCard(
    ct: readonly [bigint, bigint, bigint, bigint],
    aggregated: readonly [bigint, bigint],
  ): number {
    const out = new Int32Array(1);
    if (this.#raw.zkplayer_decrypt_card(this.#ptr, ptr(ctLimbs(ct)), ptr(pointLimbs(aggregated as [bigint, bigint])), ptr(out)) !== 0) {
      throw new Error('zkplayer_decrypt_card failed');
    }
    return out[0]!;
  }

  catalogLookup(point: readonly [bigint, bigint]): number {
    const out = new Int32Array(1);
    if (this.#raw.zkplayer_catalog_lookup(this.#ptr, ptr(pointLimbs(point as [bigint, bigint])), ptr(out)) !== 0) {
      throw new Error('zkplayer_catalog_lookup failed');
    }
    return out[0]!;
  }

  decryptFromPartials(
    sk: bigint,
    ct: readonly [bigint, bigint, bigint, bigint],
    partials: readonly (readonly [bigint, bigint, bigint, bigint])[],
  ): number {
    const flat = new BigUint64Array(partials.length * 16);
    for (let i = 0; i < partials.length; i++) {
      flat.set(ctLimbs(partials[i]!), i * 16);
    }
    const out = new Int32Array(1);
    if (this.#raw.zkplayer_decrypt_from_partials(
      this.#ptr,
      ptr(toLimbs(sk)),
      ptr(ctLimbs(ct)),
      ptr(flat),
      partials.length,
      ptr(out),
    ) !== 0) {
      throw new Error('zkplayer_decrypt_from_partials failed');
    }
    return out[0]!;
  }

  generateDerangement(n: number): number[] {
    const out = new Uint16Array(n);
    if (this.#raw.zkplayer_derangement(this.#ptr, n, ptr(out)) !== 0) {
      throw new Error('zkplayer_derangement failed');
    }
    return Array.from(out);
  }

  generateShufflePermutation(n: number): bigint[] {
    const out = new Uint8Array(n * n);
    if (this.#raw.zkplayer_shuffle_perm(this.#ptr, n, ptr(out)) !== 0) {
      throw new Error('zkplayer_shuffle_perm failed');
    }
    return Array.from(out, (bit) => BigInt(bit));
  }

  asPoseidon(): Poseidon {
    const engine = this;
    const fn = ((inputs: bigint[]) => engine.poseidonHash(inputs.map(asBig))) as unknown as Poseidon;
    fn.F = {
      toObject: (x: unknown) => asBig(x),
      e: (x: unknown) => asBig(x),
    };
    return fn;
  }

  asBabyJub(): BabyJub {
    const engine = this;
    const F = {
      e: (x: unknown) => asBig(x),
      toObject: (x: unknown) => asBig(x),
      random: () => engine.random(),
      neg: (x: unknown) => engine.neg(asBig(x)),
      eq: (a: unknown, b: unknown) => asBig(a) === asBig(b),
    };
    return {
      F,
      Base8: this.#base8,
      Generator: this.#generator,
      subOrder: this.#subOrder,
      addPoint: (a: unknown, b: unknown) => {
        const pa = a as [bigint, bigint];
        const pb = b as [bigint, bigint];
        return engine.addPoint([asBig(pa[0]), asBig(pa[1])], [asBig(pb[0]), asBig(pb[1])]);
      },
      mulPointEscalar: (p: unknown, k: unknown) => {
        const pt = p as [bigint, bigint];
        return engine.mulPoint([asBig(pt[0]), asBig(pt[1])], asBig(k));
      },
    } as unknown as BabyJub;
  }
}
