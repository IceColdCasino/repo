import { describe, expect, it } from 'vitest';
import type { GameSnapshot } from '../backend/client';
import { chooseAutoBetAction, shouldAutoAdvanceStreet } from './autoplay-betting';

function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'g',
    backend: 'solana',
    phase: 'Flop',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '10',
    currentBet: '0',
    currentPlayerSeat: 0,
    currentPlayerIndex: 0,
    bettingRoundOpen: true,
    seats: [
      { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '1000', bet: '0', folded: false, active: true },
      { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '1000', bet: '0', folded: false, active: false },
    ],
    pots: [],
    ...overrides,
  };
}

describe('autoplay betting decisions', () => {
  it('submits the closing check instead of waiting for street advance', () => {
    const decision = chooseAutoBetAction(snapshot({
      currentBet: '0',
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '1000', bet: '0', folded: false, active: true },
        { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '1000', bet: '0', folded: false, active: false },
      ],
    }), 0);

    expect(decision).toEqual({ kind: 'act', action: 'check', toCall: 0n });
  });

  it('waits on PreFlop when bets are already matched (no check)', () => {
    const decision = chooseAutoBetAction(snapshot({
      phase: 'PreFlop',
      currentBet: '20',
      currentPlayerSeat: 1,
      currentPlayerIndex: 1,
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '980', bet: '20', folded: false, active: false },
        { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '980', bet: '20', folded: false, active: true },
      ],
    }), 1);

    expect(decision).toEqual({
      kind: 'wait',
      reason: 'preflop matched — await street advance',
    });
  });

  it('calls PreFlop when facing the big blind (no check / no open-raise)', () => {
    const decision = chooseAutoBetAction(snapshot({
      phase: 'PreFlop',
      currentBet: '20',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '990', bet: '10', folded: false, active: true },
        { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '980', bet: '20', folded: false, active: false },
      ],
    }), 0);

    expect(decision).toEqual({ kind: 'act', action: 'call', toCall: 10n });
  });

  it('calls a PreFlop raise', () => {
    const decision = chooseAutoBetAction(snapshot({
      phase: 'PreFlop',
      currentBet: '40',
      currentPlayerSeat: 1,
      currentPlayerIndex: 1,
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '960', bet: '40', folded: false, active: false },
        { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '980', bet: '20', folded: false, active: true },
      ],
    }), 1);

    expect(decision).toEqual({ kind: 'act', action: 'call', toCall: 20n });
  });

  it('does not force advance while the chain says betting is open', () => {
    expect(shouldAutoAdvanceStreet(snapshot({ bettingRoundOpen: true }))).toBe(false);
  });

  it('allows advance once betting is closed', () => {
    expect(shouldAutoAdvanceStreet(snapshot({ bettingRoundOpen: false }))).toBe(true);
  });

  it('does not advance during hole-ack (holesViewPending)', () => {
    expect(shouldAutoAdvanceStreet(snapshot({
      phase: 'PreFlop',
      bettingRoundOpen: false,
      holesViewPending: true,
      currentBet: '0',
    }))).toBe(false);
  });

  it('does not skip PreFlop when blinds have not posted yet', () => {
    expect(shouldAutoAdvanceStreet(snapshot({
      phase: 'PreFlop',
      bettingRoundOpen: false,
      holesViewPending: false,
      currentBet: '0',
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '1000', bet: '0', folded: false, active: false },
        { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '1000', bet: '0', folded: false, active: false },
      ],
    }))).toBe(false);
  });

  it('allows PreFlop advance after blinds/action when round is closed', () => {
    expect(shouldAutoAdvanceStreet(snapshot({
      phase: 'PreFlop',
      bettingRoundOpen: false,
      holesViewPending: false,
      currentBet: '20',
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', chips: '980', bet: '20', folded: false, active: false },
        { seat: 1, name: 'Seat 1', publicKey: 'b', chips: '980', bet: '20', folded: false, active: false },
      ],
    }))).toBe(true);
  });
});
