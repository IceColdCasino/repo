/**
 * Open a Zig player session for any table game.
 * Native window.zero is poker-only; other games use the host FFI dylib.
 */
import { GameKind, type RouletteVariant, type ShoeDecks } from './game-config';
import {
  hasPlayerBridge,
  openWindowSession,
  type PlayerSession,
} from './player-native-bridge';
import type { SlotReels } from './house/slots';

export type GameSessionOpts = {
  kind: GameKind;
  variant?: number;
  /**
   * This seat is the house. One seat in the table, opened from `src/house`.
   * Bet and bingo-card ops are refused. The other seats stay full players.
   */
  house?: boolean;
};

async function openHouseSeat(kind: GameKind, variant: number): Promise<PlayerSession> {
  switch (kind) {
    case GameKind.Baccarat: {
      const { openHousePlayer } = await import('./house/baccarat');
      return openHousePlayer(variant as ShoeDecks) as unknown as PlayerSession;
    }
    case GameKind.Blackjack: {
      const { openHousePlayer } = await import('./house/blackjack');
      return openHousePlayer(variant as ShoeDecks) as unknown as PlayerSession;
    }
    case GameKind.War: {
      const { openHousePlayer } = await import('./house/war');
      return openHousePlayer(variant as ShoeDecks) as unknown as PlayerSession;
    }
    case GameKind.Roulette: {
      const { openHousePlayer } = await import('./house/roulette');
      return openHousePlayer(variant as RouletteVariant) as unknown as PlayerSession;
    }
    case GameKind.Craps: {
      const { openHousePlayer } = await import('./house/craps');
      return openHousePlayer() as unknown as PlayerSession;
    }
    case GameKind.Keno: {
      const { openHousePlayer } = await import('./house/keno');
      return openHousePlayer() as unknown as PlayerSession;
    }
    case GameKind.Slots: {
      const { openHousePlayer } = await import('./house/slots');
      return openHousePlayer(variant as SlotReels) as unknown as PlayerSession;
    }
    default:
      throw new Error(`no house player for kind ${kind}`);
  }
}

/** Calculations, witness generation, and Groth16 for a hand all run in libzkcasino. */
export async function tryOpenGameSession(opts: GameSessionOpts): Promise<PlayerSession> {
  if (opts.house) return openHouseSeat(opts.kind, opts.variant ?? 0);
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
