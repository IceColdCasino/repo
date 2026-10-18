/** UI game kinds — mirrors `src/game-config.ts` GameKind names. */

export const UiGameKind = {
  Poker: 'poker',
  Baccarat: 'baccarat',
  Blackjack: 'blackjack',
  War: 'war',
  Roulette: 'roulette',
} as const;

export type UiGameKind = (typeof UiGameKind)[keyof typeof UiGameKind];

export const UI_GAME_KIND_OPTIONS: ReadonlyArray<{ id: UiGameKind; label: string }> = [
  { id: 'poker', label: 'Poker' },
  { id: 'blackjack', label: 'Blackjack' },
  { id: 'war', label: 'War' },
  { id: 'baccarat', label: 'Baccarat' },
  { id: 'roulette', label: 'Roulette' },
];

const STORAGE_KEY = 'poker-game-kind';

export function isUiGameKind(value: string | null | undefined): value is UiGameKind {
  return value === 'poker'
    || value === 'blackjack'
    || value === 'war'
    || value === 'baccarat'
    || value === 'roulette';
}

export function loadUiGameKind(): UiGameKind {
  if (typeof localStorage === 'undefined') {
    return 'poker';
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  return isUiGameKind(stored) ? stored : 'poker';
}

export function saveUiGameKind(kind: UiGameKind): void {
  localStorage.setItem(STORAGE_KEY, kind);
}

export function resolveUiGameKind(): UiGameKind {
  if (typeof window !== 'undefined') {
    const query = new URLSearchParams(window.location.search).get('gameKind');
    if (isUiGameKind(query)) {
      return query;
    }
    const launch = (window as Window & { __ZK_LAUNCH_CONFIG?: { gameKind?: string } })
      .__ZK_LAUNCH_CONFIG;
    if (isUiGameKind(launch?.gameKind)) {
      return launch.gameKind;
    }
  }
  return loadUiGameKind();
}

export function seatCountForGame(kind: UiGameKind): number {
  switch (kind) {
    case 'blackjack':
      return 8;
    case 'war':
    case 'baccarat':
    case 'roulette':
      return 12;
    default:
      return 10;
  }
}

export function usesTwelveSeatRail(kind: UiGameKind): boolean {
  return kind === 'war' || kind === 'baccarat' || kind === 'roulette';
}

export function usesVersusDealerCards(kind: UiGameKind): boolean {
  return kind === 'war' || kind === 'baccarat';
}

/** Cards on the felt: War 2+2, Baccarat 3+3. Not per-seat holes. */
export function versusCardCounts(kind: UiGameKind): { player: number; dealer: number } {
  if (kind === 'baccarat') {
    return { player: 3, dealer: 3 };
  }
  if (kind === 'war') {
    return { player: 2, dealer: 2 };
  }
  return { player: 0, dealer: 0 };
}

export function usesBlackjackLayout(kind: UiGameKind): boolean {
  return kind === 'blackjack';
}

export function usesRouletteLayout(kind: UiGameKind): boolean {
  return kind === 'roulette';
}

export function allowsMultipleDealers(kind: UiGameKind): boolean {
  return usesTwelveSeatRail(kind) || kind === 'blackjack';
}
