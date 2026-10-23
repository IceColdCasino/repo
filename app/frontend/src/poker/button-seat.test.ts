import { describe, expect, it } from 'vitest';
import { buttonSeatForHand, stackAfterPayout, stackBehind } from '@poker-src/room';

describe('button and stack', () => {
  it('puts the heads-up button on the small blind and rotates with the seat order', () => {
    expect(buttonSeatForHand([1, 0])).toBe(1);
    expect(buttonSeatForHand([0, 1])).toBe(0);
  });

  it('puts the multiway button on the last seat in the action order', () => {
    expect(buttonSeatForHand([1, 2, 0])).toBe(0);
    expect(buttonSeatForHand([2, 0, 1])).toBe(1);
  });

  it('shows the buy-in minus chips already committed this hand', () => {
    expect(stackBehind(1000n, 0n)).toBe(1000n);
    expect(stackBehind(1000n, 40n)).toBe(960n);
    expect(stackBehind(1000n, 1000n)).toBe(0n);
    expect(stackBehind(80n, 1000n)).toBe(80n);
  });

  it('pays the pot to the winner and takes the committed chips from the loser', () => {
    expect(stackAfterPayout(1000n, 40n, 80n)).toBe(1040n);
    expect(stackAfterPayout(1000n, 40n, 0n)).toBe(960n);
    expect(stackAfterPayout(1040n, 0n, 0n)).toBe(1040n);
  });
});
