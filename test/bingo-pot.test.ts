import { describe, expect, test } from 'bun:test';
import { bingoBuyInPayouts } from '../src/bingo-eval';

const price = 100n;

describe('bingo buy-in pot', () => {
  test('one earliest card takes the pot', () => {
    expect(bingoBuyInPayouts(price, [
      { won: true, completionIndex: 4 },
      { won: true, completionIndex: 7 },
      { won: false, completionIndex: 0 },
    ])).toEqual([300n, 0n, 0n]);
  });

  test('the same call splits, and the odd chip goes to the lower seat', () => {
    expect(bingoBuyInPayouts(price, [
      { won: true, completionIndex: 5 },
      { won: false, completionIndex: 0 },
      { won: true, completionIndex: 5 },
    ])).toEqual([150n, 0n, 150n]);
    expect(bingoBuyInPayouts(price, [
      { won: true, completionIndex: 5 },
      { won: true, completionIndex: 5 },
      { won: true, completionIndex: 5 },
      { won: false, completionIndex: 0 },
    ])).toEqual([134n, 133n, 133n, 0n]);
  });

  test('no completion refunds every card', () => {
    expect(bingoBuyInPayouts(price, [
      { won: false, completionIndex: 0 },
      { won: false, completionIndex: 0 },
    ])).toEqual([price, price]);
  });
});
