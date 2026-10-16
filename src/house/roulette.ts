import { GameKind, RouletteVariant, type RouletteVariant as RouletteVariantT } from '../game-config';
import {
  bootHouse,
  houseLibs,
  openHouseSession,
  selfCheck as checkHouse,
  type HouseGameModule,
  type HousePlayer,
} from './session';

export const game = 'roulette';
export const kind = GameKind.Roulette;
export const variant = RouletteVariant.Eu;

export const libs = houseLibs(
  'libzkcasino-roulette.so',
  'libzkcasino-shuffle-1-deck-37.so',
  'libzkcasino-shuffle-1-deck-38.so',
);
export const dats = [
  'register.dat',
  'roulette_share.dat',
  'roulette_showdown_37.dat',
  'roulette_showdown_38.dat',
  'shuffle_1_deck_37.dat',
  'shuffle_1_deck_38.dat',
];

export function openHousePlayer(wheel: RouletteVariantT = variant): HousePlayer {
  return openHouseSession(kind, wheel);
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
