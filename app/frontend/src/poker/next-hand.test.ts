import { describe, expect, it } from 'vitest';
import {
  anySeatSittingOut,
  canSkipRegister,
  handPlayerCount,
  initialNextHandBlindGate,
  mergeSitOutRecords,
  mergeStagedDeckJson,
  nextHandBlindsAllowed,
  nextHandReadyToOpen,
  noteSitOut,
  reduceNextHandBlindGate,
  shouldSitOutNextHand,
  uncontestedFoldFinish,
  emptySitOutRecord,
} from './next-hand';
import {
  mixKeys,
  mixLimbs,
  rememberRegisterProof,
  rememberStagedShuffle,
  resetNextHandStage,
  reusableRegisterProof,
  takeStagedShuffle,
} from './next-hand-stage';

describe('next hand blinds', () => {
  it('allows the first hand and blocks the next until showdown is submitted and the hand is closed', () => {
    let gate = initialNextHandBlindGate();
    expect(nextHandBlindsAllowed(gate)).toBe(true);

    gate = reduceNextHandBlindGate(gate, 'PreFlop', false);
    gate = reduceNextHandBlindGate(gate, 'Showdown', false);
    expect(nextHandBlindsAllowed(gate)).toBe(false);
    expect(nextHandReadyToOpen(gate)).toBe(false);

    gate = reduceNextHandBlindGate(gate, 'Showdown', true);
    expect(nextHandBlindsAllowed(gate)).toBe(false);

    gate = reduceNextHandBlindGate(gate, 'Complete', false);
    expect(gate).toEqual({
      needsPreviousSettlement: true,
      showdownSubmitted: true,
      handClosed: true,
    });
    expect(nextHandBlindsAllowed(gate)).toBe(true);
    expect(nextHandReadyToOpen(gate)).toBe(true);

    gate = reduceNextHandBlindGate(gate, 'Flop', false);
    expect(nextHandBlindsAllowed(gate)).toBe(false);
  });

  it('does not treat a complete flicker as closed before showdown is submitted', () => {
    let gate = reduceNextHandBlindGate(initialNextHandBlindGate(), 'Showdown', false);
    gate = reduceNextHandBlindGate(gate, 'Complete', false);
    expect(nextHandBlindsAllowed(gate)).toBe(false);
    expect(gate.handClosed).toBe(false);
  });

  it('opens the next hand after a paid fold and locks it again on the next preflop', () => {
    let gate = reduceNextHandBlindGate(initialNextHandBlindGate(), 'PreFlop', false);
    expect(nextHandReadyToOpen(gate)).toBe(false);

    gate = reduceNextHandBlindGate(gate, 'Complete', false, true);
    expect(gate).toEqual({
      needsPreviousSettlement: true,
      showdownSubmitted: true,
      handClosed: true,
    });
    expect(nextHandReadyToOpen(gate)).toBe(true);

    gate = reduceNextHandBlindGate(gate, 'PreFlop', false, false);
    expect(nextHandReadyToOpen(gate)).toBe(false);
    expect(nextHandBlindsAllowed(gate)).toBe(false);
  });
});

describe('uncontested fold finish', () => {
  it('detects a fold that left one player and skips a submitted showdown', () => {
    expect(uncontestedFoldFinish({
      phase: 'Complete',
      actionOrder: [0, 1],
      seats: [
        { seat: 0, folded: true },
        { seat: 1, folded: false },
      ],
    })).toBe(true);
    expect(uncontestedFoldFinish({
      phase: 'Complete',
      handResult: { reason: 'fold' },
    })).toBe(true);
    expect(uncontestedFoldFinish({
      phase: 'Complete',
      handResult: { reason: 'showdown' },
      actionOrder: [0, 1],
      seats: [
        { seat: 0, folded: true },
        { seat: 1, folded: false },
      ],
    })).toBe(false);
    expect(uncontestedFoldFinish({
      phase: 'Complete',
      actionOrder: [0, 1],
      seats: [
        { seat: 0, folded: false },
        { seat: 1, folded: false },
      ],
      zkShowdown: { submittedCount: 2, finalizedOnChain: true },
    })).toBe(false);
    expect(uncontestedFoldFinish({
      phase: 'PreFlop',
      actionOrder: [0, 1],
      seats: [
        { seat: 0, folded: true },
        { seat: 1, folded: false },
      ],
    })).toBe(false);
  });
});

describe('sit out and register reuse', () => {
  it('sits out only a short stack that did not win', () => {
    expect(shouldSitOutNextHand({
      stack: 15n,
      bigBlind: 20n,
      winnersKnown: true,
      won: false,
    })).toBe(true);
    expect(shouldSitOutNextHand({
      stack: 15n,
      bigBlind: 20n,
      winnersKnown: true,
      won: true,
    })).toBe(false);
    expect(shouldSitOutNextHand({
      stack: 15n,
      bigBlind: 20n,
      winnersKnown: false,
      won: false,
    })).toBe(false);
    expect(shouldSitOutNextHand({
      stack: 20n,
      bigBlind: 20n,
      winnersKnown: true,
      won: false,
    })).toBe(false);
  });

  it('skips register when the key and the player count are unchanged', () => {
    expect(canSkipRegister({
      previousPlayerCount: 2,
      nextPlayerCount: 2,
      previousKey: 'a:b',
      nextKey: 'a:b',
    })).toBe(true);
    expect(canSkipRegister({
      previousPlayerCount: 2,
      nextPlayerCount: 3,
      previousKey: 'a:b',
      nextKey: 'a:b',
    })).toBe(false);
    expect(canSkipRegister({
      previousPlayerCount: 2,
      nextPlayerCount: 2,
      previousKey: 'a:b',
      nextKey: 'c:d',
    })).toBe(false);
    expect(handPlayerCount({
      actionOrder: [1, 0],
      seats: [{ publicKey: 'a' }, { publicKey: 'b' }, { publicKey: 'c' }],
    })).toBe(2);
  });

  it('merges sit-out stamps and keeps the later shuffle deck', () => {
    const open = noteSitOut(emptySitOutRecord('table'), 0, true, 5);
    const later = noteSitOut(emptySitOutRecord('table'), 0, false, 9);
    expect(mergeSitOutRecords(open, later).seats['0']).toEqual({ sittingOut: false, at: 9 });
    expect(anySeatSittingOut(mergeSitOutRecords(open, later))).toBe(false);
    expect(anySeatSittingOut(open)).toBe(true);

    const early = JSON.stringify({
      shufflerIndex: 0,
      playerCount: 2,
      keysMix: 'k',
      deck: [['1']],
    });
    const next = JSON.stringify({
      shufflerIndex: 1,
      playerCount: 2,
      keysMix: 'k',
      deck: [['2']],
    });
    expect(JSON.parse(mergeStagedDeckJson(early, next)).shufflerIndex).toBe(1);
    expect(JSON.parse(mergeStagedDeckJson(next, early)).shufflerIndex).toBe(1);
  });
});

describe('staged proofs', () => {
  it('reuses a register proof and a shuffle only when the statement matches', async () => {
    resetNextHandStage();
    const key = [1n, 2n] as const;
    rememberRegisterProof(2, key, { pi_a: 'p' }, ['1', '2']);
    expect(reusableRegisterProof(2, key)?.publicSignals).toEqual(['1', '2']);
    expect(reusableRegisterProof(3, key)).toBeNull();
    expect(reusableRegisterProof(2, [3n, 4n])).toBeNull();

    const deck = [[1n, 2n, 3n, 4n]];
    const keys = [[9n, 8n] as const];
    rememberStagedShuffle({
      playerIndex: 0,
      deckMix: mixLimbs(deck),
      keysMix: mixKeys(keys),
      proof: { ok: true },
      publicSignals: ['s'],
      shuffledDeck: [['9']],
    });
    expect(await takeStagedShuffle(0, [[9n]], keys)).toBeNull();
    const taken = await takeStagedShuffle(0, deck, keys);
    expect(taken?.publicSignals).toEqual(['s']);
    expect(await takeStagedShuffle(0, deck, keys)).toBeNull();
  });
});
