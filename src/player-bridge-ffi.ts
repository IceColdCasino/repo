/**
 * Bun FFI for the Zig player bridge (same JSON ops as window.zero `player`).
 * Not imported by the Vite / WebView graph — see player-bridge-ffi-shim.
 */
import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  createPlayerSession,
  type PlayerSession,
} from './player-native-bridge';

const libPath = path.join(
  import.meta.dir,
  `../libzkcasino/zig-out/lib/libzkcasino-player-bridge.${suffix}`,
);

const SYMBOLS = {
  zkplayer_bridge_create: { args: [], returns: FFIType.ptr },
  zkplayer_bridge_create_ex: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  zkplayer_bridge_free: { args: [FFIType.ptr], returns: FFIType.void },
  zkplayer_bridge_op: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

let lib: ReturnType<typeof dlopen<typeof SYMBOLS>> | undefined;

export function playerBridgeFfiAvailable(): boolean {
  return existsSync(libPath);
}

export function requirePlayerBridge(): void {
  if (!playerBridgeFfiAvailable()) {
    throw new Error(
      `libzkcasino-player-bridge not found at ${libPath}. Build it with: cd libzkcasino && zig build player-bridge-lib`,
    );
  }
}

function getLib() {
  if (!lib) {
    requirePlayerBridge();
    lib = dlopen(libPath, SYMBOLS);
  }
  return lib;
}

const OUT_CAP = 1 << 20;

function opJson(handle: NonNullable<ReturnType<ReturnType<typeof getLib>['symbols']['zkplayer_bridge_create']>>, json: string): string {
  const input = Buffer.from(json, 'utf8');
  const out = new Uint8Array(OUT_CAP);
  const lenSlot = new BigUint64Array(1);
  const rc = getLib().symbols.zkplayer_bridge_op(
    handle,
    ptr(input),
    input.length,
    ptr(out),
    OUT_CAP,
    ptr(lenSlot),
  );
  if (rc === -3) {
    throw new Error('zkplayer_bridge_op output overflow');
  }
  if (rc !== 0) {
    throw new Error(`zkplayer_bridge_op failed (${rc})`);
  }
  return new TextDecoder().decode(out.subarray(0, Number(lenSlot[0]!)));
}

type BridgeHandle = NonNullable<ReturnType<ReturnType<typeof getLib>['symbols']['zkplayer_bridge_create']>>;

const calcHandles = new Map<string, BridgeHandle>();

/** Synchronous JSON call. Handles stay open for the process. */
export function bridgeCall(kind: number, variant: number, payload: Record<string, unknown>): Record<string, unknown> {
  const key = `${kind}:${variant}`;
  let handle = calcHandles.get(key);
  if (!handle) {
    const opened = getLib();
    const created = kind === 0 && variant === 0
      ? opened.symbols.zkplayer_bridge_create()
      : opened.symbols.zkplayer_bridge_create_ex(kind, variant);
    if (!created) {
      throw new Error(`zkplayer_bridge_create failed for kind ${kind} variant ${variant}`);
    }
    handle = created;
    calcHandles.set(key, handle);
  }
  return JSON.parse(opJson(handle, JSON.stringify(payload))) as Record<string, unknown>;
}

export function openSession(opts?: { kind?: number; variant?: number }): PlayerSession {
  const opened = getLib();
  const kind = opts?.kind ?? 0;
  const variant = opts?.variant ?? 0;
  const handle = kind === 0 && variant === 0
    ? opened.symbols.zkplayer_bridge_create()
    : opened.symbols.zkplayer_bridge_create_ex(kind, variant);
  if (!handle) {
    throw new Error('zkplayer_bridge_create failed');
  }
  const invoke = (payload: Record<string, unknown>) => {
    const parsed = JSON.parse(opJson(handle, JSON.stringify(payload))) as Record<string, unknown>;
    return parsed;
  };
  return createPlayerSession(invoke, () => {
    opened.symbols.zkplayer_bridge_free(handle);
  });
}
