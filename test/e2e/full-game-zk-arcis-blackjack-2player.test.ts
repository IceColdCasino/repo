/**
 * Blackjack Arcis+ZK smoke: lazy share starts at 1×16-card chunk on-chain;
 * zkConfig still plans max chunks (2 for 2p / 4 for 4p). Further chunks open
 * via extend_share_chunks when the shoe cursor needs card 16+.
 *
 *   bun test test/e2e/full-game-zk-arcis-blackjack-2player.test.ts
 *
 * Shuffle staging uses fill-mask parallel writes (`SHUFFLE_WRITE_CONCURRENCY`, default 16).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { GameKind } from '../../src/game-config';
import { multiGameZkConfig } from '../../src/chain/multi-game-zk-config';
import { OnchainGameLifecycle } from '../../src/chain/onchain-game-lifecycle';
import { shareChunksForSeats, CHUNK_SHARE_CARDS } from '../../src/blackjack';
import { loadBlackjackCircuits, type BlackjackCircuits } from '../../src/blackjack-player';
import { ContinuousBlackjackHand } from './continuous-blackjack-hand';

describe('E2E Blackjack ZK + Arcis — share chunks', () => {
  let ctx: E2EContext;
  let circuits: BlackjackCircuits;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await loadBlackjackCircuits(6);
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test('2 seats: 2 chunks × 16 = 32 cards (≥ 24 showdown)', () => {
    const c = multiGameZkConfig(GameKind.Blackjack, { numPlayers: 2, shoeDecks: 6 });
    expect(c.nShareChunks).toBe(2);
    expect(c.shareCards).toBe(32);
    expect(c.showdownCards).toBe(24);
    expect(c.coeffCount).toBe(2);
    expect(c.dealerIndex).toBe(1);
    expect(shareChunksForSeats(2) * CHUNK_SHARE_CARDS).toBe(32);
  });

  test('4 seats: 4 chunk rounds (parallel seats × chunks)', () => {
    const c = multiGameZkConfig(GameKind.Blackjack, { numPlayers: 4, shoeDecks: 6 });
    expect(c.nShareChunks).toBe(4);
    expect(c.shareCards).toBe(64);
  });

  test(
    'initializeGames starts lazy n_share_chunks=1 and dealer + 24-card reveal',
    async () => {
      const zk = multiGameZkConfig(GameKind.Blackjack, { numPlayers: 2, shoeDecks: 6 });
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
      expect(Number(light.gameKind)).toBe(GameKind.Blackjack);
      expect(Number(light.nShareChunks)).toBe(1);
      expect(Number(light.dealerIndex)).toBe(1);
      expect(Number(light.potMask)).toBe(0);
      const poker = await (ctx.pokerProgram.account as any).gameState.fetch(pokerPda);
      expect(Number(poker.numCards)).toBe(24);
      expect(Number(poker.sharedCards ?? poker.shared_cards ?? 0)).toBe(0);
    },
    120_000,
  );

  test(
    '4-seat table also starts lazy n_share_chunks=1',
    async () => {
      const zk = multiGameZkConfig(GameKind.Blackjack, { numPlayers: 4, shoeDecks: 6 });
      const gameId = crypto.getRandomValues(new Uint8Array(32));
      const lifecycle = new OnchainGameLifecycle(
        ctx.lightPokerProgram,
        ctx.provider,
        gameId,
        ctx.pokerProgram,
      );
      await lifecycle.initializeGames(
        4,
        zk.config.kind,
        zk.config.shoeDecks,
        zk.config.rouletteVariant,
        zk.dealerIndex,
      );
      const lightPda = web3.PublicKey.findProgramAddressSync(
        [Buffer.from('game_state'), Buffer.from(gameId)],
        ctx.lightPokerProgram.programId,
      )[0];
      const light = await (ctx.lightPokerProgram.account as any).gameState.fetch(lightPda);
      expect(Number(light.nShareChunks)).toBe(1);
      expect(zk.nShareChunks).toBe(4);
    },
    120_000,
  );

  test(
    'complete hand: register→shuffle→share→staged reveal→stay+dealer action→showdown→settle',
    async () => {
      // A natural ends before showdown. Deal again until the stay path is live.
      let result: Awaited<ReturnType<ContinuousBlackjackHand['runCompleteHand']>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const hand = new ContinuousBlackjackHand(
          circuits,
          ctx.pokerProgram,
          ctx.lightPokerProgram,
          ctx.provider,
          { numPlayers: 2, shoeDecks: 6, stakeAmount: 100n },
        );
        result = await hand.runCompleteHand();
        if (!result.skippedShowdown) break;
      }
      if (!result) throw new Error('blackjack hand did not run');

      expect(result.deckHash).not.toBe(0n);
      expect(result.handSettled).toBe(true);
      expect(result.showdownSubmitterPlayerIndex).toBe(0);
      expect([0, 1, 2, 3]).toContain(result.outcome);
      // Player stay + dealer initial (parallel); dealer may prove more after stay.
      expect(result.actionProofCount).toBeGreaterThanOrEqual(2);
      // Always-stay path keeps a live player hand → showdown required.
      expect(result.skippedShowdown).toBe(false);
      expect(result.sealedCoefficients).toHaveLength(2);
      for (const c of result.sealedCoefficients) {
        expect(c).not.toBe(0n);
      }
      expect(result.showdownHash).toBe(
        (BigInt(result.outcome) + 1n) * result.sealedCoefficients[0]!
          + result.sealedCoefficients[1]!,
      );
      expect(result.phase).toBeGreaterThanOrEqual(3);
    },
    1_800_000,
  );
});
