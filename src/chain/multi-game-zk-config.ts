/**
 * Per-game Arcis+ZK continuous-hand configuration.
 * Mirrors shared-zk-ids card/coeff counts and blackjack share chunking.
 */
import {
  GameKind,
  BINGO_CHUNK_BALLS,
  bingoShareChunks,
  gameKindNeedsHouseSeat,
  normalizeGameConfig,
  revealCardCount,
  showdownCardCount,
  showdownCoeffCount,
  shuffleCircuitId,
  type GameConfig,
} from '../game-config';
import { shareChunksForSeats, CHUNK_SHARE_CARDS } from '../blackjack';

export interface MultiGameZkConfig {
  config: GameConfig;
  /** Poker-program num_cards (reveal / showdown materials). */
  numCards: number;
  showdownCards: number;
  coeffCount: number;
  shuffleCircuit: string;
  shareCircuit: string;
  showdownCircuit: string;
  /** Blackjack: share chunk rounds; 1 for other games. */
  nShareChunks: number;
  /** Cards covered by share chunks (BJ) or deal size. */
  shareCards: number;
  /** Dealer seat index, or 255 if none. */
  dealerIndex: number;
}

export function multiGameZkConfig(
  kind: GameKind,
  opts: {
    numPlayers: number;
    shoeDecks?: number;
    rouletteVariant?: number;
    dealerIndex?: number;
  },
): MultiGameZkConfig {
  const shoeDecks = opts.shoeDecks ?? (kind === GameKind.Poker ? 1 : 6);
  const rouletteVariant =
    opts.rouletteVariant
    ?? (kind === GameKind.Roulette ? 37 : kind === GameKind.Slots ? 3 : kind === GameKind.Bingo ? 75 : 0);
  const config = normalizeGameConfig(kind, shoeDecks, rouletteVariant);
  const needsDealer = gameKindNeedsHouseSeat(kind);
  const dealerIndex = needsDealer
    ? (opts.dealerIndex ?? opts.numPlayers - 1)
    : 255;
  if (needsDealer && (dealerIndex < 0 || dealerIndex >= opts.numPlayers)) {
    throw new Error('dealerIndex must be in [0, numPlayers)');
  }

  const nShareChunks =
    kind === GameKind.Blackjack
      ? shareChunksForSeats(opts.numPlayers)
      : kind === GameKind.Bingo
        ? bingoShareChunks(config.rouletteVariant)
        : 1;
  const shareCards =
    kind === GameKind.Blackjack
      ? nShareChunks * CHUNK_SHARE_CARDS
      : kind === GameKind.Bingo
        ? BINGO_CHUNK_BALLS
        : showdownCardCount(config);

  const shareCircuit = (() => {
    switch (kind) {
      case GameKind.Poker:
        return 'poker_share_hashout_main';
      case GameKind.Baccarat:
        return 'baccarat_share_hashout_main';
      case GameKind.War:
        return 'war_share_hashout_main';
      case GameKind.Blackjack:
        return 'blackjack_share_hashout_main';
      case GameKind.Roulette:
        return 'roulette_share_hashout_main';
      case GameKind.Craps:
        return 'craps_share_hashout_main';
      case GameKind.Keno:
        return 'keno_share_hashout_main';
      case GameKind.Slots:
        return `slot_share_${config.rouletteVariant}_reel_hashout_main`;
      case GameKind.Bingo:
        return 'bingo_share_hashout_main';
      default:
        throw new Error(`unsupported kind ${kind}`);
    }
  })();

  const showdownCircuit = (() => {
    switch (kind) {
      case GameKind.Poker:
        return 'poker_showdown_hashout_main';
      case GameKind.Baccarat:
        return 'baccarat_showdown_hashout_main';
      case GameKind.War:
        return 'war_showdown_hashout_main';
      case GameKind.Blackjack:
        return 'blackjack_showdown_hashout_main';
      case GameKind.Roulette:
        return `roulette_showdown_${config.rouletteVariant}_hashout_main`;
      case GameKind.Craps:
        return 'craps_showdown_hashout_main';
      case GameKind.Keno:
        return 'keno_showdown_hashout_main';
      case GameKind.Slots:
        return `slot_showdown_${config.rouletteVariant}_reel_hashout_main`;
      case GameKind.Bingo:
        return `bingo_showdown_${config.rouletteVariant}_hashout_main`;
      default:
        throw new Error(`unsupported kind ${kind}`);
    }
  })();

  return {
    config,
    numCards: revealCardCount(config),
    showdownCards: showdownCardCount(config),
    coeffCount: showdownCoeffCount(config),
    shuffleCircuit: shuffleCircuitId(config),
    shareCircuit,
    showdownCircuit,
    nShareChunks,
    shareCards,
    dealerIndex,
  };
}
