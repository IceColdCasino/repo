import { describe, expect, test } from 'bun:test';
import { Bingo, BINGO_CHUNK_BALLS, N_OTHERS as BINGO_OTHERS } from '../src/bingo';
import { Blackjack, CHUNK_SHARE_CARDS, N_OTHERS as BLACKJACK_OTHERS } from '../src/blackjack';
import { Baccarat, BACCARAT_STREET_COUNT, N_OTHERS as BACCARAT_OTHERS, TOTAL_CARDS as BACCARAT_CARDS } from '../src/baccarat';
import { Poker } from '../src/poker';
import type { Ciphertext } from '../src/zk-casino';
import {
  baccaratStreetFieldGroups,
  bingoBallFieldGroups,
  blackjackCardFieldGroups,
  pokerStreetFieldGroups,
} from '../src/share-street-fields';

function grid(rows: number, cards: number): Ciphertext[][] {
  return Array.from({ length: rows }, (_, recipient) =>
    Array.from({ length: cards }, (_, card) => {
      const base = BigInt(recipient * 1000 + card * 10 + 1);
      return [base, base + 1n, base + 2n, base + 3n] as Ciphertext;
    }),
  );
}

function column(rows: Ciphertext[][], index: number): Ciphertext[] {
  return rows.map((row) => row[index]!);
}

describe('two-tier share hash', () => {
  test('blackjack publishes every card hash and the output is their fold', () => {
    const blackjack = new Blackjack();
    const partials = grid(BLACKJACK_OTHERS, CHUNK_SHARE_CARDS);
    const commitment = blackjack.shareCardCommitment(partials, 2);
    expect(commitment.cards).toHaveLength(CHUNK_SHARE_CARDS);
    expect(commitment.finalHash).toBe(blackjack.computeChunkShareOutputHash(partials, 2));

    const opened = column(partials, 1);
    const cardHash = commitment.cards[1];
    if (cardHash === undefined) throw new Error('missing card hash');
    expect(blackjack.cardShareHash(opened)).toBe(cardHash);

    const tampered = opened.map((limb, index) =>
      index === 0 ? [limb[0]! + 1n, limb[1]!, limb[2]!, limb[3]!] as Ciphertext : limb,
    );
    expect(blackjack.cardShareHash(tampered)).not.toBe(cardHash);
  });

  test('bingo publishes every ball hash and the output is their fold', () => {
    const bingo = new Bingo(75);
    const partials = grid(BINGO_OTHERS, BINGO_CHUNK_BALLS);
    const commitment = bingo.shareBallCommitment(partials, 2);
    expect(commitment.balls).toHaveLength(BINGO_CHUNK_BALLS);
    expect(commitment.finalHash).toBe(bingo.computeShareOutputHash(partials, 2));

    const opened = column(partials, 3);
    const ballHash = commitment.balls[3];
    if (ballHash === undefined) throw new Error('missing ball hash');
    expect(bingo.ballShareHash(opened)).toBe(ballHash);

    const tampered = opened.map((limb, index) =>
      index === 0 ? [limb[0]! + 1n, limb[1]!, limb[2]!, limb[3]!] as Ciphertext : limb,
    );
    expect(bingo.ballShareHash(tampered)).not.toBe(ballHash);
  });

  test('poker publishes every street hash and the output is their fold', () => {
    const poker = new Poker();
    const partials = grid(9, 25);
    const commitment = poker.shareCommitments(partials, 2);
    expect(commitment.streets).toHaveLength(13);
    expect(commitment.finalHash).toBe(poker.computeShareOutputHash(partials, 2));
    expect(commitment.streets.every((hash) => hash !== 0n && hash !== commitment.finalHash)).toBe(true);
  });

  test('baccarat publishes four street hashes and the output is their fold', () => {
    const baccarat = new Baccarat();
    const partials = grid(BACCARAT_OTHERS, BACCARAT_CARDS);
    const commitment = baccarat.shareStreetCommitment(partials, 2);
    expect(commitment.streets).toHaveLength(BACCARAT_STREET_COUNT);
    expect(commitment.finalHash).toBe(baccarat.computeShareOutputHash(partials, 2));
    const playerHand = commitment.streets[0];
    const bankerThird = commitment.streets[3];
    if (playerHand === undefined || bankerThird === undefined) throw new Error('missing street hash');
    expect(playerHand).not.toBe(bankerThird);
    expect(playerHand).not.toBe(commitment.finalHash);
  });

  test('street uploads are 12-field chunks and do not cross a street', () => {
    const poker = pokerStreetFieldGroups(grid(9, 25)).map((fields) => fields.length);
    expect(poker).toEqual([72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 108, 36, 36]);
    const blackjack = blackjackCardFieldGroups(grid(7, 16)).map((fields) => fields.length);
    expect(blackjack).toEqual(Array(16).fill(28));
    const bingo = bingoBallFieldGroups(grid(11, 5)).map((fields) => fields.length);
    expect(bingo).toEqual(Array(5).fill(44));
    const baccarat = baccaratStreetFieldGroups(grid(11, 6)).map((fields) => fields.length);
    expect(baccarat).toEqual([88, 88, 44, 44]);
    for (const length of [...poker, ...blackjack, ...bingo, ...baccarat]) {
      expect(Math.ceil(length / 12)).toBeGreaterThan(1);
    }
  });
});
