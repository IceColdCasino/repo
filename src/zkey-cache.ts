import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prover, proveFromFile } from './rapidsnark-ffi';

export interface SharedZkeyBytes {
  path: string;
  bytes: Uint8Array;
}

export interface SharedProver {
  prove(witnessData: Uint8Array): ReturnType<Prover['prove']>;
}

const MAX_IN_MEMORY_ZKEY_BYTES = 256_000_000;

/** Large zkeys: one-shot file prove (stateful FileProver segfaults under Bun FFI). */
function createStatelessFileProver(zkeyPath: string): SharedProver {
  return {
    prove(witnessData) {
      return proveFromFile(zkeyPath, witnessData);
    },
  };
}

interface CacheEntry {
  prover: SharedProver;
  zkeyData?: Uint8Array;
}

const sharedZkeys = new Map<string, SharedZkeyBytes>();
const sharedProvers = new Map<string, CacheEntry>();

function canonicalZkeyPath(zkeyPath: string): string {
  return realpathSync(resolve(zkeyPath));
}

function readFileIntoSharedArrayBuffer(zkeyPath: string): Uint8Array {
  const size = Bun.file(zkeyPath).size;
  if (size > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Zkey too large to map into JS memory: ${zkeyPath}`);
  }

  const buffer = new SharedArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  const fd = openSync(zkeyPath, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, bytes, offset, size - offset, offset);
      if (n === 0) throw new Error(`Unexpected EOF while reading ${zkeyPath}`);
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  return bytes;
}

/**
 * Returns one canonical shared zkey byte buffer per zkey path. The buffer is a
 * SharedArrayBuffer-backed Uint8Array so worker proofs can access the same zkey
 * bytes without copying/reloading the multi-GB zkey per worker.
 */
export function getSharedZkeyBytes(zkeyPath: string): SharedZkeyBytes {
  const key = canonicalZkeyPath(zkeyPath);
  const existing = sharedZkeys.get(key);
  if (existing) return existing;

  const entry = { path: key, bytes: readFileIntoSharedArrayBuffer(key) };
  sharedZkeys.set(key, entry);
  return entry;
}

export function sharedZkeyByteLoadCount(zkeyPath: string): number {
  return sharedZkeys.has(canonicalZkeyPath(zkeyPath)) ? 1 : 0;
}

export function getSharedProver(zkeyPath: string): SharedProver {
  const key = canonicalZkeyPath(zkeyPath);
  const existing = sharedProvers.get(key);
  if (existing) return existing.prover;

  const fileSize = Bun.file(key).size;

  if (fileSize > MAX_IN_MEMORY_ZKEY_BYTES) {
    const prover = createStatelessFileProver(key);
    sharedProvers.set(key, { prover });
    return prover;
  }

  try {
    const zkeyData = getSharedZkeyBytes(key).bytes;
    const prover = new Prover(zkeyData);
    sharedProvers.set(key, { prover, zkeyData });
    return prover;
  } catch {
    const prover = createStatelessFileProver(key);
    sharedProvers.set(key, { prover });
    return prover;
  }
}

export function sharedProverLoadCount(zkeyPath: string): number {
  return sharedProvers.has(canonicalZkeyPath(zkeyPath)) ? 1 : 0;
}

export function clearSharedProvers(): void {
  for (const entry of sharedProvers.values()) {
    const maybeDestroy = entry.prover as { destroy?: () => void };
    if (typeof maybeDestroy.destroy === 'function') maybeDestroy.destroy();
  }
  sharedProvers.clear();
}

export function clearSharedZkeyBytes(): void {
  clearSharedProvers();
  sharedZkeys.clear();
}
