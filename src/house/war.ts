import { GameKind, ShoeDecks, type ShoeDecks as ShoeDecksT } from '../game-config';
import {
  CARD_SHOE_DATS,
  CARD_SHOE_LIBS,
  bootHouse,
  houseLibs,
  openHouseSession,
  selfCheck as checkHouse,
  type HouseGameModule,
  type HousePlayer,
} from './session';

export const game = 'war';
export const kind = GameKind.War;
export const variant = ShoeDecks.Six;

export const libs = houseLibs('libzkcasino-war.so', ...CARD_SHOE_LIBS);
export const dats = [
  'register.dat',
  'war_share.dat',
  'war_showdown.dat',
  ...CARD_SHOE_DATS,
];

export function openHousePlayer(decks: ShoeDecksT = variant): HousePlayer {
  return openHouseSession(kind, decks);
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
