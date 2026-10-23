import { describe, expect, test } from 'bun:test';
import idl from './idl/casino.json';
import { finishedHandCanClose } from './per-seat-hand';

describe('finishedHandCanClose', () => {
  test('closes a verified showdown whose pot callback never started', () => {
    expect(finishedHandCanClose({
      phase: 5,
      showdownFinalized: true,
      settlementStatus: 1,
    })).toBe(true);
  });

  test('closes a settled hand', () => {
    expect(finishedHandCanClose({
      phase: 6,
      showdown_finalized: true,
      settlement_status: 3,
    })).toBe(true);
  });

  test('leaves an in-flight pot callback open', () => {
    expect(finishedHandCanClose({
      phase: 5,
      showdownFinalized: true,
      settlementStatus: 2,
    })).toBe(false);
  });

  test('leaves an unproved showdown open', () => {
    expect(finishedHandCanClose({
      phase: 5,
      showdownFinalized: false,
      settlementStatus: 0,
    })).toBe(false);
  });

  test('leaves a live street open', () => {
    expect(finishedHandCanClose({
      phase: 3,
      showdownFinalized: false,
      settlementStatus: 0,
    })).toBe(false);
  });

  test('end_hand carries the game account the program writes', () => {
    const ix = (idl as { instructions: Array<{ name: string; accounts: Array<{ name: string }> }> })
      .instructions.find((entry) => entry.name === 'end_hand');
    expect(ix?.accounts.map((account) => account.name)).toEqual([
      'authority',
      'room',
      'table_state',
      'game_state',
    ]);
  });
});
