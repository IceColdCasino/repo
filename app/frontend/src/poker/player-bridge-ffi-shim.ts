/**
 * WebView stub — host Zig player-bridge FFI never ships in the macOS/iOS apps.
 * `initialDeck` is pure BabyJub identity cards, so vitest can build a deck
 * without the native calc bridge.
 */
import { buildBabyjub, type BabyJub } from 'circomlibjs';

const babyjub: BabyJub = await buildBabyjub();

function identityCard(scalar: number): string[] {
  const point = babyjub.mulPointEscalar(babyjub.Base8, BigInt(scalar));
  return [
    '0',
    '1',
    String(babyjub.F.toObject(point[0])),
    String(babyjub.F.toObject(point[1])),
  ];
}

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
  if (payload.op === 'calc' && payload.fn === 'initialDeck') {
    const count = Number(payload.count ?? 0);
    const decks = Number(payload.decks ?? 1);
    const deck: string[][] = [];
    for (let deckIndex = 0; deckIndex < decks; deckIndex += 1) {
      for (let card = 0; card < count; card += 1) {
        deck.push(identityCard(card + 1));
      }
    }
    void kind;
    void variant;
    return { ok: true, deck };
  }
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
