/**
 * Open a Zig player session for any table game.
 * Native window.zero is poker-only; other games use the host FFI dylib.
 */
import { GameKind } from './game-config';
import {
  hasPlayerBridge,
  openWindowSession,
  type PlayerSession,
} from './player-native-bridge';

export type GameSessionOpts = {
  kind: GameKind;
  variant?: number;
};

/** Calculations, witness generation, and Groth16 for a hand all run in libzkcasino. */
export async function tryOpenGameSession(opts: GameSessionOpts): Promise<PlayerSession> {
  if (opts.kind === GameKind.Poker && hasPlayerBridge()) {
    return openWindowSession();
  }
  const ffi = await import('./player-bridge-ffi');
  ffi.requirePlayerBridge();
  return ffi.openSession({ kind: opts.kind, variant: opts.variant ?? 0 });
}

export function shuffleVariant(circuitName: string): number {
  const reel = circuitName.match(/shuffle_(\d+)_reel/);
  if (reel) return Number(reel[1]);
  const deck = circuitName.match(/shuffle_(\d+)_deck_(\d+)/);
  if (!deck) return 0;
  const count = Number(deck[1]);
  const size = Number(deck[2]);
  return size === 52 ? count : size;
}
