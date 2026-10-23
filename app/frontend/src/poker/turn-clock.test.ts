import { describe, expect, it } from 'vitest';
import { shouldAutoCheckBeforeDeadline } from './turn-clock';

const base = {
  canAct: true,
  callAmount: 0,
  busy: false,
  deadlineUnix: 1_000,
  nowUnix: 997,
  alreadySentForDeadline: 0,
};

describe('shouldAutoCheckBeforeDeadline', () => {
  it('checks inside the last three seconds when nothing is owed', () => {
    expect(shouldAutoCheckBeforeDeadline({ ...base, nowUnix: 997 })).toBe(true);
    expect(shouldAutoCheckBeforeDeadline({ ...base, nowUnix: 999 })).toBe(true);
  });

  it('waits until the last three seconds', () => {
    expect(shouldAutoCheckBeforeDeadline({ ...base, nowUnix: 996 })).toBe(false);
  });

  it('does not check once the window has closed', () => {
    expect(shouldAutoCheckBeforeDeadline({ ...base, nowUnix: 1_000 })).toBe(false);
    expect(shouldAutoCheckBeforeDeadline({ ...base, nowUnix: 1_001 })).toBe(false);
  });

  it('does not check into a bet, while busy, or twice for the same deadline', () => {
    expect(shouldAutoCheckBeforeDeadline({ ...base, callAmount: 20 })).toBe(false);
    expect(shouldAutoCheckBeforeDeadline({ ...base, busy: true })).toBe(false);
    expect(shouldAutoCheckBeforeDeadline({ ...base, canAct: false })).toBe(false);
    expect(shouldAutoCheckBeforeDeadline({ ...base, alreadySentForDeadline: 1_000 })).toBe(false);
  });
});
