/** Mirrors rust/shared-zk-ids GameKind / shoe / roulette variant. */

export const GameKind = {
  Poker: 0,
  Baccarat: 1,
  Blackjack: 2,
  War: 3,
  Roulette: 4,
  Craps: 5,
  Keno: 6,
  Slots: 7,
  Bingo: 8,
} as const;
export type GameKind = (typeof GameKind)[keyof typeof GameKind];

export const ShoeDecks = {
  One: 1,
  Six: 6,
  Eight: 8,
} as const;
export type ShoeDecks = (typeof ShoeDecks)[keyof typeof ShoeDecks];

export const RouletteVariant = {
  Eu: 37,
  Us: 38,
} as const;
export type RouletteVariant = (typeof RouletteVariant)[keyof typeof RouletteVariant];

export interface GameConfig {
  kind: GameKind;
  shoeDecks: number;
  rouletteVariant: number;
}

export function normalizeGameConfig(
  kind: GameKind,
  shoeDecks = 1,
  rouletteVariant = 0,
): GameConfig {
  if (kind === GameKind.Poker) {
    if (rouletteVariant !== 0) throw new Error('poker rejects roulette_variant');
    return { kind, shoeDecks: 1, rouletteVariant: 0 };
  }
  if (kind === GameKind.Baccarat || kind === GameKind.Blackjack || kind === GameKind.War) {
    if (rouletteVariant !== 0) throw new Error('card game rejects roulette_variant');
    if (shoeDecks !== 1 && shoeDecks !== 6 && shoeDecks !== 8) {
      throw new Error(`invalid shoe_decks ${shoeDecks}`);
    }
    return { kind, shoeDecks, rouletteVariant: 0 };
  }
  if (kind === GameKind.Roulette) {
    if (rouletteVariant !== 37 && rouletteVariant !== 38) {
      throw new Error(`invalid roulette_variant ${rouletteVariant}`);
    }
    return { kind, shoeDecks: 0, rouletteVariant };
  }
  if (kind === GameKind.Craps || kind === GameKind.Keno) {
    if (rouletteVariant !== 0) throw new Error('craps/keno reject roulette_variant');
    return { kind, shoeDecks: 0, rouletteVariant: 0 };
  }
  if (kind === GameKind.Slots) {
    if (rouletteVariant !== 3 && rouletteVariant !== 5) {
      throw new Error(`invalid slots reel count ${rouletteVariant}`);
    }
    return { kind, shoeDecks: 0, rouletteVariant };
  }
  if (kind === GameKind.Bingo) {
    if (rouletteVariant !== 75 && rouletteVariant !== 90) {
      throw new Error(`invalid bingo variant ${rouletteVariant}`);
    }
    return { kind, shoeDecks: 0, rouletteVariant };
  }
  throw new Error(`invalid game_kind ${kind}`);
}

/** Shuffle circuit zkey / witness name for a validated config. */
export function shuffleCircuitId(config: GameConfig): string {
  if (config.kind === GameKind.Poker) return 'shuffle_1_deck_52_main';
  if (
    config.kind === GameKind.Baccarat ||
    config.kind === GameKind.Blackjack ||
    config.kind === GameKind.War
  ) {
    return `shuffle_${config.shoeDecks}_deck_52_main`;
  }
  if (config.kind === GameKind.Craps) return 'shuffle_2_dice_6_main';
  if (config.kind === GameKind.Keno) return 'shuffle_1_deck_80_main';
  if (config.kind === GameKind.Slots) {
    return `shuffle_${config.rouletteVariant}_reel_22_main`;
  }
  if (config.kind === GameKind.Bingo) {
    return `shuffle_1_deck_${config.rouletteVariant}_main`;
  }
  return `shuffle_1_deck_${config.rouletteVariant}_main`;
}

/** Faces per craps die (die-major shoe). */
export const CRAPS_FACES_PER_DIE = 6;
/** Stops per slot reel (reel-major shoe). */
export const SLOT_STOPS_PER_REEL = 22;

/**
 * Shoe indices of the shared / showdown deal cards.
 * RevealedCard PDAs stay compact `0..n-1`; only the deck hash is sparse.
 */
export function shareDealCardIndices(config: GameConfig): number[] {
  const n = showdownCardCount(config);
  if (config.kind === GameKind.Craps) {
    return [0, CRAPS_FACES_PER_DIE];
  }
  if (config.kind === GameKind.Slots) {
    return Array.from({ length: n }, (_, i) => i * SLOT_STOPS_PER_REEL);
  }
  return Array.from({ length: n }, (_, i) => i);
}

/** Fixed cards in showdown / Arcis reveal materials (mirrors shared-zk-ids). */
export function showdownCardCount(config: GameConfig): number {
  switch (config.kind) {
    case GameKind.Poker:
      return 25;
    case GameKind.Baccarat:
      return 6;
    case GameKind.War:
      return 4;
    case GameKind.Blackjack:
      return 24;
    case GameKind.Roulette:
      return 1;
    case GameKind.Craps:
      return 2;
    case GameKind.Keno:
      return 20;
    case GameKind.Slots:
      return config.rouletteVariant;
    case GameKind.Bingo:
      return config.rouletteVariant;
    default:
      throw new Error(`invalid game_kind ${config.kind}`);
  }
}

/** Poker-program `num_cards` for Arcis reveal / showdown materials. */
export function revealCardCount(config: GameConfig): number {
  return showdownCardCount(config);
}

/** Active showdown polynomial-hash coefficients (pad to SHOWDOWN_MAX_COEFFS). */
export function showdownCoeffCount(config: GameConfig): number {
  switch (config.kind) {
    case GameKind.Poker:
      return 9;
    case GameKind.Baccarat:
    case GameKind.War:
    case GameKind.Blackjack:
      return 1;
    case GameKind.Roulette:
      return 12;
    case GameKind.Craps:
      return 14;
    case GameKind.Keno:
    case GameKind.Slots:
      return 1;
    case GameKind.Bingo:
      return config.rouletteVariant === 90 ? 3 : 1;
    default:
      throw new Error(`invalid game_kind ${config.kind}`);
  }
}

/** House/dealer seat that must shuffle and cannot place an economic bet. */
export function gameKindNeedsHouseSeat(kind: GameKind): boolean {
  return (
    kind === GameKind.Roulette
    || kind === GameKind.Blackjack
    || kind === GameKind.Craps
    || kind === GameKind.Keno
    || kind === GameKind.Slots
  );
}

/** Max sealed showdown coefficients (craps 14); smaller games pad unused slots. */
export const SHOWDOWN_MAX_COEFFS = 14;

/** Blackjack: chunks scale with seats (players + dealer), min 2, max 19. */
export function blackjackShareChunksForSeats(nSeats: number): number {
  return Math.max(2, Math.min(19, nSeats));
}

/** Bingo 5-ball share window. */
export const BINGO_CHUNK_BALLS = 5;
export const BINGO_CARD_75_CELLS = 25;
export const BINGO_CARD_90_CELLS = 27;

export function bingoShareChunks(variant: number): number {
  if (variant === 75) return 15;
  if (variant === 90) return 18;
  throw new Error(`invalid bingo variant ${variant}`);
}

export function bingoCalledBalls(nShareChunks: number): number {
  return nShareChunks * BINGO_CHUNK_BALLS;
}
