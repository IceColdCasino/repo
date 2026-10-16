/**
 * Roulette Arcis+ZK smoke (2 seats, dealer actualBetCount=0).
 *
 *   bun test test/e2e/full-game-zk-arcis-roulette-2player.test.ts
 *
 * Shuffle staging uses fill-mask parallel writes (`SHUFFLE_WRITE_CONCURRENCY`).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { GameKind } from '../../src/game-config';
import { multiGameZkConfig } from '../../src/chain/multi-game-zk-config';
import { OnchainGameLifecycle } from '../../src/chain/onchain-game-lifecycle';
import { loadRouletteCircuits, type RouletteCircuits } from '../../src/roulette-player';
import { Roulette } from '../../src/roulette';
import { ContinuousRouletteHand } from './continuous-roulette-hand';

describe('E2E Roulette ZK + Arcis — 2 Players', () => {
  let ctx: E2EContext;
  let circuits: RouletteCircuits;
  let roulette: Roulette;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await loadRouletteCircuits(37);
    roulette = new Roulette(37);
    await roulette.init();
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test('config: 1 card, 2 coeffs, dealer seat', () => {
    const c = multiGameZkConfig(GameKind.Roulette, {
      numPlayers: 2,
      rouletteVariant: 37,
      dealerIndex: 1,
    });
    expect(c.showdownCards).toBe(1);
    expect(c.coeffCount).toBe(2);
    expect(c.dealerIndex).toBe(1);
    expect(c.shareCircuit).toBe('roulette_share_hashout_main');
  });

  test(
    'initializeGames wires roulette + dealer pot exclusion + 1-card reveal',
    async () => {
      const zk = multiGameZkConfig(GameKind.Roulette, {
        numPlayers: 2,
        rouletteVariant: 37,
        dealerIndex: 1,
      });
      const gameId = crypto.getRandomValues(new Uint8Array(32));
      const lifecycle = new OnchainGameLifecycle(
        ctx.lightPokerProgram,
        ctx.provider,
        gameId,
        ctx.pokerProgram,
      );
      await lifecycle.initializeGames(
        2,
        zk.config.kind,
        zk.config.shoeDecks,
        zk.config.rouletteVariant,
        zk.dealerIndex,
      );
      const lightPda = web3.PublicKey.findProgramAddressSync(
        [Buffer.from('game_state'), Buffer.from(gameId)],
        ctx.lightPokerProgram.programId,
      )[0];
      const pokerPda = web3.PublicKey.findProgramAddressSync(
        [Buffer.from('game_state'), Buffer.from(gameId)],
        ctx.pokerProgram.programId,
      )[0];
      const light = await (ctx.lightPokerProgram.account as any).gameState.fetch(lightPda);
      expect(Number(light.gameKind)).toBe(GameKind.Roulette);
      expect(Number(light.rouletteVariant)).toBe(37);
      expect(Number(light.dealerIndex)).toBe(1);
      expect(Number(light.potMask)).toBe(0);
      const poker = await (ctx.pokerProgram.account as any).gameState.fetch(pokerPda);
      expect(Number(poker.numCards)).toBe(1);
    },
    120_000,
  );

  test(
    'complete hand: register→shuffle→share→reveal→seal→showdown→settle',
    async () => {
      const hand = new ContinuousRouletteHand(
        circuits,
        ctx.pokerProgram,
        ctx.lightPokerProgram,
        ctx.provider,
        { numPlayers: 2, rouletteVariant: 37, stakeAmount: 100n },
      );

      const result = await hand.runCompleteHand();

      expect(result.sealedCoefficients).toHaveLength(2);
      for (const c of result.sealedCoefficients) {
        expect(c).not.toBe(0n);
      }
      expect(result.showdownHash).toBe(
        roulette.computeShowdownOutputHash(result.payouts, result.sealedCoefficients),
      );
      expect(result.payouts.length).toBe(12);
      expect(result.deckHash).not.toBe(0n);
      expect(result.handSettled).toBe(true);
      expect(result.showdownSubmitterPlayerIndex).toBe(0);
      expect(result.phase).toBeGreaterThanOrEqual(3);
    },
    1_800_000,
  );
});
