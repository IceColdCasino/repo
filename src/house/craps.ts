import { GameKind } from '../game-config';
import {
  bootHouse,
  houseLibs,
  openHouseSession,
  selfCheck as checkHouse,
  type HouseGameModule,
  type HousePlayer,
} from './session';

export const game = 'craps';
export const kind = GameKind.Craps;
export const variant = 0;

export const libs = houseLibs(
  'libzkcasino-craps.so',
  'libzkcasino-shuffle-2-dice-6.so',
);
export const dats = [
  'register.dat',
  'craps_share.dat',
  'craps_showdown.dat',
  'shuffle_2_dice_6.dat',
];

export function openHousePlayer(): HousePlayer {
  return openHouseSession(kind, variant);
}

const house: HouseGameModule = {
  game,
  kind,
  variant,
  libs,
  dats,
  openHousePlayer,
};

export function selfCheck(): Promise<void> {
  return checkHouse(house);
}

if (import.meta.main) {
  await bootHouse(house);
}
