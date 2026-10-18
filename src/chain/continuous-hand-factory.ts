/**
 * Route a backend game kind to the matching Continuous*Hand + circuit loader
 * and the on-chain initializeGames arguments.
 */
import type { Program, AnchorProvider } from '@coral-xyz/anchor';
import { GameKind } from '../game-config';
import {
  parseBackendGameKind,
  toChainGameKind,
  defaultShoeDecks,
  defaultRouletteVariant,
  type BackendGameKind,
} from '../backend/game-kind';
import { multiGameZkConfig, type MultiGameZkConfig } from './multi-game-zk-config';
import { ContinuousZkArcisHand } from './continuous-zk-arcis-hand';
import { ContinuousBlackjackHand } from './continuous-blackjack-hand';
import { ContinuousCasinoHand } from './continuous-casino-hand';
import { ContinuousRouletteHand } from './continuous-roulette-hand';
import { ContinuousCrapsHand } from './continuous-craps-hand';
import { ContinuousKenoHand } from './continuous-keno-hand';
import { ContinuousSlotHand } from './continuous-slot-hand';
import { ContinuousBingoHand } from './continuous-bingo-hand';
import { preloadCircuits, type Circuits } from '../circuit-manager';
import { loadBlackjackCircuits, type BlackjackCircuits } from '../blackjack-player';
import { loadWarCircuits, type WarCircuits } from '../war-player';
import { loadBaccaratCircuits, type BaccaratCircuits } from '../baccarat-player';
import { loadRouletteCircuits, type RouletteCircuits } from '../roulette-player';
import { loadCrapsCircuits, type CrapsCircuits } from '../craps-player';
import { loadKenoCircuits, type KenoCircuits } from '../keno-player';
import { loadSlotCircuits, type SlotCircuits } from '../slot-player';
import { loadBingoCircuits, type BingoCircuits } from '../bingo-player';

export type ContinuousGameHand =
  | ContinuousZkArcisHand
  | ContinuousBlackjackHand
  | ContinuousCasinoHand
  | ContinuousRouletteHand
  | ContinuousCrapsHand
  | ContinuousKenoHand
  | ContinuousSlotHand
  | ContinuousBingoHand;

export interface ChainGameInitArgs {
  numPlayers: number;
  gameKind: GameKind;
  shoeDecks: number;
  rouletteVariant: number;
  dealerIndex: number;
  zk: MultiGameZkConfig;
}

export function chainInitArgsForGame(
  kind: BackendGameKind | string | number,
  numPlayers: number,
): ChainGameInitArgs {
  const backend = parseBackendGameKind(kind);
  const chain = toChainGameKind(backend);
  const zk = multiGameZkConfig(chain, {
    numPlayers,
    shoeDecks: defaultShoeDecks(backend),
    rouletteVariant: defaultRouletteVariant(backend),
  });
  return {
    numPlayers,
    gameKind: zk.config.kind,
    shoeDecks: zk.config.shoeDecks,
    rouletteVariant: zk.config.rouletteVariant,
    dealerIndex: zk.dealerIndex,
    zk,
  };
}

/** Union of poker + casino CompDefs (upload once per localnet). */
export function allArciumHandCompDefs(): string[] {
  return [...new Set([
    ...ContinuousZkArcisHand.HAND_COMP_DEFS,
    ...ContinuousBlackjackHand.HAND_COMP_DEFS,
    ...ContinuousCasinoHand.HAND_COMP_DEFS,
    ...ContinuousRouletteHand.HAND_COMP_DEFS,
    ...ContinuousCrapsHand.HAND_COMP_DEFS,
    ...ContinuousKenoHand.HAND_COMP_DEFS,
    ...ContinuousSlotHand.HAND_COMP_DEFS,
    ...ContinuousBingoHand.HAND_COMP_DEFS,
  ])];
}

export async function loadCircuitsForGame(kind: BackendGameKind): Promise<unknown> {
  switch (kind) {
    case 'blackjack':
      return loadBlackjackCircuits(6);
    case 'war':
      return loadWarCircuits(6);
    case 'baccarat':
      return loadBaccaratCircuits(1);
    case 'roulette':
      return loadRouletteCircuits(37);
    case 'craps':
      return loadCrapsCircuits();
    case 'keno':
      return loadKenoCircuits();
    case 'slots':
      return loadSlotCircuits(3);
    case 'bingo':
      return loadBingoCircuits(75);
    default:
      return preloadCircuits();
  }
}

export function createContinuousHand(opts: {
  kind: BackendGameKind;
  circuits: unknown;
  pokerProgram: Program;
  lightPokerProgram: Program;
  provider: AnchorProvider;
  numPlayers: number;
}): ContinuousGameHand {
  const { kind, circuits, pokerProgram, lightPokerProgram, provider, numPlayers } = opts;
  switch (kind) {
    case 'blackjack':
      return new ContinuousBlackjackHand(
        circuits as BlackjackCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { numPlayers, shoeDecks: 6 },
      );
    case 'war':
      return new ContinuousCasinoHand(
        circuits as WarCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { gameKind: GameKind.War, numPlayers, shoeDecks: 6 },
      );
    case 'baccarat':
      return new ContinuousCasinoHand(
        circuits as BaccaratCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { gameKind: GameKind.Baccarat, numPlayers, shoeDecks: 1 },
      );
    case 'roulette':
      return new ContinuousRouletteHand(
        circuits as RouletteCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { numPlayers, rouletteVariant: 37, dealerIndex: numPlayers > 1 ? 1 : 0 },
      );
    case 'craps':
      return new ContinuousCrapsHand(
        circuits as CrapsCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { numPlayers, dealerIndex: numPlayers > 1 ? 1 : 0 },
      );
    case 'keno':
      return new ContinuousKenoHand(
        circuits as KenoCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { numPlayers, dealerIndex: numPlayers > 1 ? 1 : 0 },
      );
    case 'slots':
      return new ContinuousSlotHand(
        circuits as SlotCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { numPlayers: 2, variant: 3, dealerIndex: 1 },
      );
    case 'bingo':
      return new ContinuousBingoHand(
        circuits as BingoCircuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        { numPlayers, variant: 75 },
      );
    default:
      return new ContinuousZkArcisHand(
        circuits as Circuits,
        pokerProgram,
        lightPokerProgram,
        provider,
        numPlayers,
      );
  }
}

export function isPokerContinuousHand(hand: ContinuousGameHand): hand is ContinuousZkArcisHand {
  return hand instanceof ContinuousZkArcisHand;
}
