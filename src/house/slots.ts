import { GameKind } from '../game-config';
import {
  bootHouse,
  houseLibs,
  openHouseSession,
  selfCheck as checkHouse,
  type HouseGameModule,
  type HousePlayer,
} from './session';

export const game = 'slots';
export const kind = GameKind.Slots;
export const variant = 3;

export const libs = houseLibs(
  'libzkcasino-slots.so',
  'libzkcasino-shuffle-3-reel-22.so',
  'libzkcasino-shuffle-5-reel-22.so',
);
export const dats = [
  'register.dat',
  'slot_share_3_reel.dat',
  'slot_share_5_reel.dat',
  'slot_showdown_3_reel.dat',
  'slot_showdown_5_reel.dat',
  'shuffle_3_reel_22.dat',
  'shuffle_5_reel_22.dat',
];

export type SlotReels = 3 | 5;

export function openHousePlayer(reels: SlotReels = variant): HousePlayer {
  return openHouseSession(kind, reels);
}

const house: HouseGameModule = {
  game,
  kind,
  variant,
  libs,
  dats,
  openHousePlayer: () => openHousePlayer(),
};

export function selfCheck(): Promise<void> {
  return checkHouse(house);
}

if (import.meta.main) {
  await bootHouse(house);
}
