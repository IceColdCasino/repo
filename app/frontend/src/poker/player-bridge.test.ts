import { describe, expect, it } from 'vitest';
import { hasPlayerBridge } from './player-bridge';

describe('player-bridge', () => {
  it('is inactive in jsdom (no window.zero)', () => {
    expect(hasPlayerBridge()).toBe(false);
  });
});
