/**
 * Slots Arcis+ZK smoke (exactly 2 seats). Coin-bet stays fused with share.
 *
 *   bun test test/e2e/full-game-zk-arcis-slots-2player.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { setupE2E, teardownE2E, E2E_SETUP_TIMEOUT_MS, type E2EContext } from './setup';
import { GameKind } from '../../src/game-config';
import { multiGameZkConfig } from '../../src/chain/multi-game-zk-config';
import { OnchainGameLifecycle } from '../../src/chain/onchain-game-lifecycle';
import { loadSlotCircuits, type SlotCircuits } from '../../src/slot-player';
import { Slot } from '../../src/slot';
import { ContinuousSlotHand } from './continuous-slot-hand';

describe('E2E Slots ZK + Arcis — 2 Players', () => {
  let ctx: E2EContext;
  let circuits: SlotCircuits;
  let slot: Slot;

  beforeAll(async () => {
    ctx = await setupE2E();
    circuits = await loadSlotCircuits(3);
    slot = new Slot(3);
    await slot.init();
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await teardownE2E(ctx);
  });

  test('config: 3 reels, 2 coeffs, house seat, fused share', () => {
    const c = multiGameZkConfig(GameKind.Slots, {
      numPlayers: 2,
      rouletteVariant: 3,
    });
    expect(c.showdownCards).toBe(3);
    expect(c.coeffCount).toBe(2);
    expect(c.dealerIndex).toBe(1);
    expect(c.shareCircuit).toBe('slot_share_3_reel_hashout_main');
    expect(c.shuffleCircuit).toBe('shuffle_3_reel_22_main');
  });

  test(
    'initializeGames wires slots + 3-card poker num_cards',
    async () => {
      const zk = multiGameZkConfig(GameKind.Slots, {
        numPlayers: 2,
        rouletteVariant: 3,
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
      expect(Number(light.gameKind)).toBe(GameKind.Slots);
      expect(Number(light.rouletteVariant)).toBe(3);
      expect(Number(light.dealerIndex)).toBe(1);
      expect(Number(light.potMask)).toBe(0);
      const poker = await (ctx.pokerProgram.account as any).gameState.fetch(pokerPda);
      expect(Number(poker.numCards)).toBe(3);
    },
    120_000,
  );

  test(
    'complete 3-reel hand: register→shuffle→share(coin-bet)→reveal→seal→showdown→settle',
    async () => {
      const hand = new ContinuousSlotHand(
        circuits,
        ctx.pokerProgram,
        ctx.lightPokerProgram,
        ctx.provider,
        { numPlayers: 2, variant: 3, stakeAmount: 100n, coinBets: [1], dealerIndex: 1 },
      );

      const result = await hand.runCompleteHand();

      expect(result.sealedCoefficients).toHaveLength(2);
      for (const c of result.sealedCoefficients) expect(c).not.toBe(0n);
      expect(result.showdownHash).toBe(
        slot.computeShowdownOutputHash(result.payout, result.sealedCoefficients),
      );
      expect(result.deckHash).not.toBe(0n);
      expect(result.handSettled).toBe(true);
      expect(result.phase).toBeGreaterThanOrEqual(3);
    },
    1_800_000,
  );
});
