/**
 * Poker: continuous 2-player hand exercising ALL Groth16 + Arcis circuits together.
 *
 * Groth16: register_main, shuffle_1_deck_52_main, poker_share_hashout_main,
 *          poker_showdown_hashout_main
 * Arcis:   verify_deck_hash_chunk (ExtractAndCombine fold), reveal_card
 *          (sealed partials only — never plaintext cards), validate_bet,
 *          seal_showdown_coefficients, compute_pots
 *
 * Shuffle staging uses fill-mask parallel writes (`SHUFFLE_WRITE_CONCURRENCY`).
 *
 *   bun test test/e2e/full-game-zk-arcis-poker-2player.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { preloadCircuits, type Circuits } from '../../src/circuit-manager';
import { ContinuousZkArcisHand } from './continuous-zk-arcis-hand';
import { computeWinnerMaskHash } from './winner-mask-utils';

describe('E2E Poker ZK + Arcis — 2 Players', () => {
  let ctx: E2EContext;
  let circuits: Circuits;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await preloadCircuits();
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test(
    'complete hand: 4 Groth16 + Arcis sealed-partials verify/reveal/bet/seal/pots',
    async () => {
      const hand = new ContinuousZkArcisHand(
        circuits,
        ctx.pokerProgram,
        ctx.lightPokerProgram,
        ctx.provider,
        2,
      );

      const result = await hand.runComplete2PlayerHand();

      expect(result.winnerMasks).toHaveLength(9);
      expect(result.sealedCoefficients).toHaveLength(2);
      expect(result.sealedCoefficients.every((c) => c !== 0n)).toBe(true);
      expect(result.phase).toBe(6); // PotsDistributed

      // Showdown public output must match sealed-coeff poly hash
      const expected = computeWinnerMaskHash(result.winnerMasks, result.sealedCoefficients);
      expect(result.showdownHash).toBe(expected);

      // Deck hash is non-trivial after ExtractAndCombine
      expect(result.deckHash).not.toBe(0n);
    },
    1_800_000,
  );
});
