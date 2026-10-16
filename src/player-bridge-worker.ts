/**
 * One Groth16 bridge call per thread. The dylib is process-wide, so a pointer
 * created on the main thread is valid here. Slot checkout inside the engine
 * keeps concurrent proves of the same circuit from sharing a witness context.
 */
import { parentPort } from 'node:worker_threads';
import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import * as path from 'node:path';

function zkcasinoLib(file: string): string {
  const dir = process.env.ZKCASINO_LIB_DIR;
  if (dir && dir.length > 0) return path.join(dir, file);
  return path.join(import.meta.dir, '../libzkcasino/zig-out/lib', file);
}

const SYMBOLS = {
  zkplayer_bridge_op_u64: {
    args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

const lib = dlopen(zkcasinoLib(`libzkcasino-player-bridge.${suffix}`), SYMBOLS);
const OUT_CAP = 1 << 20;

function op(handle: bigint, json: string): string {
  const input = Buffer.from(json, 'utf8');
  const out = new Uint8Array(OUT_CAP);
  const lenSlot = new BigUint64Array(1);
  const rc = lib.symbols.zkplayer_bridge_op_u64(
    handle,
    ptr(input),
    input.length,
    ptr(out),
    OUT_CAP,
    ptr(lenSlot),
  );
  if (rc === -3) throw new Error('zkplayer_bridge_op output overflow');
  if (rc !== 0) throw new Error(`zkplayer_bridge_op failed (${rc})`);
  return new TextDecoder().decode(out.subarray(0, Number(lenSlot[0]!)));
}

type Request = { id: number; handle: string; json: string };

parentPort?.on('message', (msg: Request) => {
  try {
    parentPort?.postMessage({ id: msg.id, body: op(BigInt(msg.handle), msg.json) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ id: msg.id, error });
  }
});
