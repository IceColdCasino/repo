/**
 * Bingo Arcis+ZK smoke (2 seats, no house).
 * Card commit after registration; first 5-ball share chunk then showdown.
 *
 *   bun test test/e2e/full-game-zk-arcis-bingo-2player.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { GameKind } from '../../src/game-config';
import { multiGameZkConfig } from '../../src/chain/multi-game-zk-config';
import { OnchainGameLifecycle } from '../../src/chain/onchain-game-lifecycle';
import { loadBingoCircuits, type BingoCircuits } from '../../src/bingo-player';
import { Bingo } from '../../src/bingo';
import { ContinuousBingoHand } from './continuous-bingo-hand';

describe('E2E Bingo ZK + Arcis — 2 Players', () => {
  let ctx: E2EContext;
  let circuits: BingoCircuits;
  let bingo: Bingo;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await loadBingoCircuits(75);
    bingo = new Bingo(75);
    await bingo.init();
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test('config: 75-ball PvP, 15 chunks, no house', () => {
    const c = multiGameZkConfig(GameKind.Bingo, {
      numPlayers: 2,
      rouletteVariant: 75,
    });
    expect(c.showdownCards).toBe(75);
    expect(c.coeffCount).toBe(2);
    expect(c.dealerIndex).toBe(255);
    expect(c.nShareChunks).toBe(15);
    expect(c.shareCircuit).toBe('bingo_share_hashout_main');
    expect(c.shuffleCircuit).toBe('shuffle_1_deck_75_main');
  });

  test(
    'initializeGames wires bingo + all-seat pot + 75-card reveal window',
    async () => {
      const zk = multiGameZkConfig(GameKind.Bingo, {
        numPlayers: 2,
        rouletteVariant: 75,
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
      expect(Number(light.gameKind)).toBe(GameKind.Bingo);
      expect(Number(light.dealerIndex)).toBe(255);
      expect(Number(light.potMask)).toBe(0);
      const poker = await (ctx.pokerProgram.account as any).gameState.fetch(pokerPda);
      expect(Number(poker.numCards)).toBe(75);
    },
    120_000,
  );

  test(
    'complete hand: register→cardCommit→shuffle→share5→reveal→seal→showdown→settle',
    async () => {
      const hand = new ContinuousBingoHand(
        circuits,
        ctx.pokerProgram,
        ctx.lightPokerProgram,
        ctx.provider,
        { numPlayers: 2, variant: 75, stakeAmount: 100n },
      );

      const result = await hand.runCompleteHand();

      expect(result.sealedCoefficients).toHaveLength(2);
      for (const c of result.sealedCoefficients) expect(c).not.toBe(0n);
      expect(result.showdownHash).toBe(
        bingo.computeShowdownOutputHash75(
          result.packed as number,
          result.sealedCoefficients,
        ),
      );
      expect(result.nCalled).toBe(5);
      expect(result.deckHash).not.toBe(0n);
      expect(result.handSettled).toBe(true);
      expect(result.phase).toBeGreaterThanOrEqual(3);
    },
    1_800_000,
  );
});
