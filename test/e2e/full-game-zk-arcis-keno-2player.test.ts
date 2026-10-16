/**
 * Keno Arcis+ZK smoke (2 seats, dealer ticket empty).
 * Betting runs after registration and before sealed partials are revealed.
 *
 *   bun test test/e2e/full-game-zk-arcis-keno-2player.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { GameKind } from '../../src/game-config';
import { multiGameZkConfig } from '../../src/chain/multi-game-zk-config';
import { OnchainGameLifecycle } from '../../src/chain/onchain-game-lifecycle';
import { loadKenoCircuits, type KenoCircuits } from '../../src/keno-player';
import { Keno } from '../../src/keno';
import { ContinuousKenoHand } from './continuous-keno-hand';

describe('E2E Keno ZK + Arcis — 2 Players', () => {
  let ctx: E2EContext;
  let circuits: KenoCircuits;
  let keno: Keno;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await loadKenoCircuits();
    keno = new Keno();
    await keno.init();
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test('config: 20 cards, 2 coeffs, dealer seat, split bet/share', () => {
    const c = multiGameZkConfig(GameKind.Keno, {
      numPlayers: 2,
      dealerIndex: 1,
    });
    expect(c.showdownCards).toBe(20);
    expect(c.coeffCount).toBe(2);
    expect(c.dealerIndex).toBe(1);
    expect(c.shareCircuit).toBe('keno_share_hashout_main');
    expect(c.shuffleCircuit).toBe('shuffle_1_deck_80_main');
  });

  test(
    'initializeGames wires keno + dealer pot exclusion + 20-card reveal',
    async () => {
      const zk = multiGameZkConfig(GameKind.Keno, {
        numPlayers: 2,
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
      expect(Number(light.gameKind)).toBe(GameKind.Keno);
      expect(Number(light.dealerIndex)).toBe(1);
      expect(Number(light.potMask)).toBe(0);
      const poker = await (ctx.pokerProgram.account as any).gameState.fetch(pokerPda);
      expect(Number(poker.numCards)).toBe(20);
    },
    120_000,
  );

  test(
    'complete hand: register→bet→shuffle→share→reveal→seal→showdown→settle',
    async () => {
      const hand = new ContinuousKenoHand(
        circuits,
        ctx.pokerProgram,
        ctx.lightPokerProgram,
        ctx.provider,
        { numPlayers: 2, stakeAmount: 100n },
      );

      const result = await hand.runCompleteHand();

      expect(result.sealedCoefficients).toHaveLength(2);
      for (const c of result.sealedCoefficients) expect(c).not.toBe(0n);
      expect(result.showdownHash).toBe(
        keno.computeShowdownOutputHash(result.matches, result.sealedCoefficients),
      );
      expect(result.deckHash).not.toBe(0n);
      expect(result.handSettled).toBe(true);
      expect(result.phase).toBeGreaterThanOrEqual(3);
    },
    1_800_000,
  );
});
