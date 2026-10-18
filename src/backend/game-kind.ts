/**
 * Backend / API game-kind strings. Mirrors `src/game-config.ts` GameKind and
 * the frontend `UiGameKind` ids so the selector, local server, and Arcium
 * path share one vocabulary.
 */
import {
  GameKind,
  normalizeGameConfig,
  type GameConfig,
} from '../game-config';

export const BackendGameKind = {
  Poker: 'poker',
  Baccarat: 'baccarat',
  Blackjack: 'blackjack',
  War: 'war',
  Roulette: 'roulette',
  Craps: 'craps',
  Keno: 'keno',
  Slots: 'slots',
  Bingo: 'bingo',
} as const;

export type BackendGameKind = (typeof BackendGameKind)[keyof typeof BackendGameKind];

const BACKEND_KINDS = new Set<string>(Object.values(BackendGameKind));

export function isBackendGameKind(value: unknown): value is BackendGameKind {
  return typeof value === 'string' && BACKEND_KINDS.has(value);
}

export function parseBackendGameKind(value: unknown, fallback: BackendGameKind = 'poker'): BackendGameKind {
  if (isBackendGameKind(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return chainGameKindToBackend(value as GameKind);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (isBackendGameKind(trimmed)) {
      return trimmed;
    }
    const asNum = Number(trimmed);
    if (Number.isInteger(asNum)) {
      return chainGameKindToBackend(asNum as GameKind);
    }
  }
  return fallback;
}

export function toChainGameKind(kind: BackendGameKind): GameKind {
  switch (kind) {
    case 'baccarat':
      return GameKind.Baccarat;
    case 'blackjack':
      return GameKind.Blackjack;
    case 'war':
      return GameKind.War;
    case 'roulette':
      return GameKind.Roulette;
    case 'craps':
      return GameKind.Craps;
    case 'keno':
      return GameKind.Keno;
    case 'slots':
      return GameKind.Slots;
    case 'bingo':
      return GameKind.Bingo;
    default:
      return GameKind.Poker;
  }
}

export function chainGameKindToBackend(kind: GameKind): BackendGameKind {
  switch (kind) {
    case GameKind.Baccarat:
      return 'baccarat';
    case GameKind.Blackjack:
      return 'blackjack';
    case GameKind.War:
      return 'war';
    case GameKind.Roulette:
      return 'roulette';
    case GameKind.Craps:
      return 'craps';
    case GameKind.Keno:
      return 'keno';
    case GameKind.Slots:
      return 'slots';
    case GameKind.Bingo:
      return 'bingo';
    default:
      return 'poker';
  }
}

export function seatCountForBackendGame(kind: BackendGameKind): number {
  switch (kind) {
    case 'blackjack':
      return 8;
    case 'war':
    case 'baccarat':
    case 'roulette':
    case 'craps':
    case 'keno':
      return 12;
    case 'slots':
      return 2;
    case 'bingo':
      return 12;
    default:
      return 10;
  }
}

export function defaultShoeDecks(kind: BackendGameKind): number {
  if (kind === 'poker') return 1;
  if (kind === 'roulette' || kind === 'craps' || kind === 'keno' || kind === 'slots' || kind === 'bingo') return 0;
  if (kind === 'baccarat') return 1;
  return 6;
}

export function defaultRouletteVariant(kind: BackendGameKind): number {
  if (kind === 'roulette') return 37;
  if (kind === 'slots') return 3;
  if (kind === 'bingo') return 75;
  return 0;
}

export function gameConfigForBackendKind(kind: BackendGameKind): GameConfig {
  return normalizeGameConfig(
    toChainGameKind(kind),
    defaultShoeDecks(kind),
    defaultRouletteVariant(kind),
  );
}

export function usesStreetBetting(kind: BackendGameKind): boolean {
  return kind === 'poker';
}

export function usesCasinoSettlement(kind: BackendGameKind): boolean {
  return kind !== 'poker';
}
