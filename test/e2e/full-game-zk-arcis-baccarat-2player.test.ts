/**
 * Continuous 2-player Baccarat hand: Groth16 + Arcis share/reveal/seal/showdown +
 * dealer-pool settlement.
 *
 *   bun test test/e2e/full-game-zk-arcis-baccarat-2player.test.ts
 *
 * Shuffle staging uses fill-mask parallel writes (`SHUFFLE_WRITE_CONCURRENCY`).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { GameKind } from '../../src/game-config';
import { multiGameZkConfig } from '../../src/chain/multi-game-zk-config';
import { OnchainGameLifecycle } from '../../src/chain/onchain-game-lifecycle';
import { loadBaccaratCircuits, type BaccaratCircuits } from '../../src/baccarat-player';
import { ContinuousCasinoHand } from './continuous-casino-hand';

describe('E2E Baccarat ZK + Arcis — 2 Players', () => {
  let ctx: E2EContext;
  let circuits: BaccaratCircuits;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await loadBaccaratCircuits(6);
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test('config: 6 cards, 2 coeffs, baccarat circuits', () => {
    const c = multiGameZkConfig(GameKind.Baccarat, { numPlayers: 2, shoeDecks: 6 });
    expect(c.shuffleCircuit).toBe('shuffle_6_deck_52_main');
    expect(c.showdownCards).toBe(6);
    expect(c.coeffCount).toBe(2);
    expect(c.shareCircuit).toContain('baccarat');
    expect(c.showdownCircuit).toContain('baccarat');
  });

  test(
    'initializeGames wires baccarat kind + 6-card poker num_cards',
    async () => {
      const zk = multiGameZkConfig(GameKind.Baccarat, { numPlayers: 2, shoeDecks: 6 });
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
      expect(Number(light.gameKind)).toBe(GameKind.Baccarat);
      expect(Number(light.shoeDecks)).toBe(6);
      expect(Number(light.potMask)).toBe(0);
      const poker = await (ctx.pokerProgram.account as any).gameState.fetch(pokerPda);
      expect(Number(poker.numCards)).toBe(6);
    },
    120_000,
  );

  test(
    'complete hand: register→shuffle→share→reveal→seal→showdown→settle',
    async () => {
      const hand = new ContinuousCasinoHand(
        circuits,
        ctx.pokerProgram,
        ctx.lightPokerProgram,
        ctx.provider,
        { gameKind: GameKind.Baccarat, numPlayers: 2, shoeDecks: 6, stakeAmount: 100n },
      );

      const result = await hand.runCompleteHand();

      expect(result.winner === 0n || result.winner === 1n || result.winner === 2n).toBe(true);
      expect(result.sealedCoefficients).toHaveLength(2);
      for (const c of result.sealedCoefficients) expect(c).not.toBe(0n);
      expect(result.showdownHash).toBe(
        (result.winner + 1n) * result.sealedCoefficients[0]! + result.sealedCoefficients[1]!,
      );
      expect(result.deckHash).not.toBe(0n);
      expect(result.handSettled).toBe(true);
      expect(result.phase).toBeGreaterThanOrEqual(3);
    },
    1_800_000,
  );
});
