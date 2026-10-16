/**
 * House seat on the host libraries. No image build.
 *
 *   bun test test/house.test.ts
 *   bun test test/house.test.ts -t craps
 *
 * The image still asserts a closed library set and `HouseDoesNotBet`.
 * This file checks the same session against `libzkcasino/zig-out`.
 */
import { describe, expect, test } from 'bun:test';
import { GameKind } from '../src/game-config';
import { tryOpenGameSession } from '../src/player-zig-session';
import { selfCheck as checkBaccarat } from '../src/house/baccarat';
import { selfCheck as checkBlackjack } from '../src/house/blackjack';
import { selfCheck as checkCraps } from '../src/house/craps';
import { selfCheck as checkKeno } from '../src/house/keno';
import { selfCheck as checkRoulette } from '../src/house/roulette';
import { selfCheck as checkSlots } from '../src/house/slots';
import { selfCheck as checkWar } from '../src/house/war';

const HOUSE_CHECKS = [
  ['baccarat', checkBaccarat],
  ['blackjack', checkBlackjack],
  ['war', checkWar],
  ['roulette', checkRoulette],
  ['craps', checkCraps],
  ['keno', checkKeno],
  ['slots', checkSlots],
] as const;

describe('house player on the host', () => {
  for (const [game, check] of HOUSE_CHECKS) {
    test(`${game} pings, keys, and refuses bets`, () => check(), 120_000);
  }

  test('the house seat refuses bets and a player seat does not', async () => {
    const house = await tryOpenGameSession({ kind: GameKind.Keno, house: true });
    const player = await tryOpenGameSession({ kind: GameKind.Keno });
    expect('bet' in house).toBe(false);
    expect('bet' in player).toBe(true);
    expect(() => house.invoke({ op: 'bet' })).toThrow('house player does not place bets');
    expect(() => house.invoke({ op: 'card' })).toThrow('house player does not place bets');
    house.close();
    player.close();
  });
});
