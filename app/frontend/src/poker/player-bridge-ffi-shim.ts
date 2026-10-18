/** WebView stub — host Zig player-bridge FFI never ships in the macOS/iOS apps. */

export function playerBridgeFfiAvailable(): boolean {
  return false;
}

export function requirePlayerBridge(): void {
  throw new Error('player-bridge-ffi is not available in the native app or browser');
}

export function openSession(_opts?: { kind?: number; variant?: number }): never {
  throw new Error('player-bridge-ffi is not available in the native app or browser');
}

type ZeroBridge = {
  invoke?: (command: string, payload?: unknown) => unknown;
  invokeSync?: (command: string, payload?: unknown) => unknown;
};

/** Sync calc used by casino-calc. The macOS player command is the native handler. */
export function bridgeCall(
  kind: number,
  variant: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const zero = (globalThis as { window?: { zero?: ZeroBridge } }).window?.zero;
  const call = zero?.invokeSync ?? zero?.invoke;
  if (!call) {
    throw new Error('player calc bridge is not available');
  }
  const result = call.call(zero, 'player', { ...payload, kind, variant });
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    throw new Error('player calc bridge is not synchronous');
  }
  if (!result || typeof result !== 'object') {
    throw new Error('player calc bridge returned nothing');
  }
  return result as Record<string, unknown>;
}
