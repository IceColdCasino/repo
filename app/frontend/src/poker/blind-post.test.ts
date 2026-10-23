import { describe, expect, it } from 'vitest';
import type { GameSnapshot } from '../backend/client';
import {
  blindsReady,
  claimHeldByOther,
  describeBlindPrompt,
  emptyBlindPosts,
  mergeBlindPosts,
  noteAuto,
  noteClaim,
  notePosted,
} from './blind-post';

function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'table',
    backend: 'solana',
    phase: 'PreFlop',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '10',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    handNumber: 3,
    seats: [
      { seat: 0, name: 'a', publicKey: 'a', chips: '1000', bet: '0', folded: false, active: true },
      { seat: 1, name: 'b', publicKey: 'b', chips: '1000', bet: '0', folded: false, active: true },
    ],
    pots: [],
    ...overrides,
  };
}

describe('blind posts', () => {
  it('asks the small blind to post when automatic collection is off', () => {
    const prompt = describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 0,
      autoCollect: false,
      record: emptyBlindPosts('table', 3),
    });
    expect(prompt).toMatchObject({
      text: 'Post the small blind (10)',
      tone: 'you',
      canPost: true,
      role: 'small',
      amount: '10',
    });
  });

  it('asks the big blind, then waits on them after the small blind posts', () => {
    const open = emptyBlindPosts('table', 3);
    const big = describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 1,
      autoCollect: false,
      record: open,
    });
    expect(big?.text).toBe('Post the big blind (20)');

    const posted = notePosted(open, 0, 1);
    const waiting = describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 0,
      autoCollect: false,
      record: posted,
    });
    expect(waiting).toMatchObject({
      text: 'Waiting on seat 1 to post the big blind',
      tone: 'seat',
      canPost: false,
    });
    expect(blindsReady(posted, {
      smallSeat: 0,
      bigSeat: 1,
      smallAmount: '10',
      bigAmount: '20',
    })).toBe(false);
    expect(blindsReady(notePosted(posted, 1, 2), {
      smallSeat: 0,
      bigSeat: 1,
      smallAmount: '10',
      bigAmount: '20',
    })).toBe(true);
  });

  it('stays quiet once both blinds are covered, and waits when the other seat still has to post', () => {
    const bothAuto = noteAuto(noteAuto(emptyBlindPosts('table', 3), 0, true, 1), 1, true, 2);
    expect(describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 0,
      autoCollect: true,
      record: null,
    })).toBeNull();
    expect(describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 0,
      autoCollect: true,
      record: bothAuto,
    })).toBeNull();
    expect(describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 0,
      autoCollect: true,
      record: noteAuto(emptyBlindPosts('table', 3), 1, false, 2),
    })?.text).toBe('Waiting on seat 1 to post the big blind');
    expect(describeBlindPrompt({
      snapshot: snapshot({ currentBet: '20' }),
      localSeat: 0,
      autoCollect: false,
      record: null,
    })).toBeNull();
    expect(describeBlindPrompt({
      snapshot: snapshot(),
      localSeat: 0,
      autoCollect: false,
      record: null,
      previousHandSettled: false,
    })).toBeNull();
  });

  it('merges both seats and keeps the earlier collect claim', () => {
    const small = notePosted(noteAuto(emptyBlindPosts('table', 3), 0, false, 5), 0, 10);
    const big = notePosted(noteClaim(emptyBlindPosts('table', 3), 1, 30), 1, 20);
    const merged = mergeBlindPosts(small, big);
    expect(merged.posted).toEqual({ 0: 10, 1: 20 });
    expect(merged.auto['0']).toEqual({ on: false, at: 5 });
    expect(merged.claim).toEqual({ seat: 1, at: 30 });

    const earlier = noteClaim(emptyBlindPosts('table', 3), 0, 8);
    expect(mergeBlindPosts(earlier, merged).claim).toEqual({ seat: 0, at: 8 });
    expect(claimHeldByOther(mergeBlindPosts(earlier, merged), 1, 100)).toBe(true);
    const tie = mergeBlindPosts(
      noteClaim(emptyBlindPosts('table', 3), 1, 40),
      noteClaim(emptyBlindPosts('table', 3), 0, 40),
    );
    expect(tie.claim).toEqual({ seat: 0, at: 40 });
    expect(claimHeldByOther(mergeBlindPosts(earlier, merged), 0, 100)).toBe(false);
  });

  it('drops the previous hand when the hand number changes', () => {
    const previous = notePosted(emptyBlindPosts('table', 3), 0, 10);
    const next = emptyBlindPosts('table', 4);
    expect(mergeBlindPosts(previous, next).posted).toEqual({});
    expect(mergeBlindPosts(previous, next).handNumber).toBe(4);
  });
});
