import { GameKind } from '../game-config';
import {
  bootHouse,
  houseLibs,
  openHouseSession,
  selfCheck as checkHouse,
  type HouseGameModule,
  type HousePlayer,
} from './session';

export const game = 'keno';
export const kind = GameKind.Keno;
export const variant = 0;

export const libs = houseLibs(
  'libzkcasino-keno.so',
  'libzkcasino-shuffle-1-deck-80.so',
);
export const dats = [
  'register.dat',
  'keno_share.dat',
  'keno_showdown.dat',
  'shuffle_1_deck_80.dat',
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
