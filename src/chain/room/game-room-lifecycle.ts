import { type Program, type AnchorProvider } from '@coral-xyz/anchor';
import {
  deriveGameRoomId,
  GAME_ROOM_DEFAULTS,
  randomGameRoomInstanceSeed,
  type GameRoomType,
} from '../../room-lifecycle';
import { OnchainRoomLifecycle } from './onchain-room-lifecycle';

function createGameRoomLifecycle(game: GameRoomType) {
  return class GameRoomLifecycle extends OnchainRoomLifecycle {
    static readonly gameType = game;

    constructor(
      pokerProgram: Program,
      provider: AnchorProvider,
      instanceSeed?: string | Uint8Array,
    ) {
      super(
        pokerProgram,
        provider,
        deriveGameRoomId(game, instanceSeed ?? randomGameRoomInstanceSeed()),
      );
    }

    defaultSmallBlind(): bigint {
      return GAME_ROOM_DEFAULTS[game].smallBlind;
    }
  };
}

export const PokerRoomLifecycle = createGameRoomLifecycle('poker');
export const BaccaratRoomLifecycle = createGameRoomLifecycle('baccarat');
export const BlackjackRoomLifecycle = createGameRoomLifecycle('blackjack');
export const WarRoomLifecycle = createGameRoomLifecycle('war');
export const RouletteRoomLifecycle = createGameRoomLifecycle('roulette');
export const CrapsRoomLifecycle = createGameRoomLifecycle('craps');
export const KenoRoomLifecycle = createGameRoomLifecycle('keno');
export const SlotsRoomLifecycle = createGameRoomLifecycle('slots');
export const BingoRoomLifecycle = createGameRoomLifecycle('bingo');

export type PokerRoomLifecycle = InstanceType<typeof PokerRoomLifecycle>;
export type BaccaratRoomLifecycle = InstanceType<typeof BaccaratRoomLifecycle>;
export type BlackjackRoomLifecycle = InstanceType<typeof BlackjackRoomLifecycle>;
export type WarRoomLifecycle = InstanceType<typeof WarRoomLifecycle>;
export type RouletteRoomLifecycle = InstanceType<typeof RouletteRoomLifecycle>;
export type CrapsRoomLifecycle = InstanceType<typeof CrapsRoomLifecycle>;
export type KenoRoomLifecycle = InstanceType<typeof KenoRoomLifecycle>;
export type SlotsRoomLifecycle = InstanceType<typeof SlotsRoomLifecycle>;
export type BingoRoomLifecycle = InstanceType<typeof BingoRoomLifecycle>;
