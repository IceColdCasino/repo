import { describe, expect, it } from 'vitest';
import {
  SMOKING_PUNKS,
  avatarForPublicKey,
  punkGridCoords,
  punkSpriteFillStyle,
  resetAvatarAssignmentsForTests,
} from './smoking-punks';

describe('smoking-punks', () => {
  it('assigns a stable smoking punk per public key', () => {
    resetAvatarAssignmentsForTests();
    const first = avatarForPublicKey('player-a');
    const second = avatarForPublicKey('player-a');
    expect(first).toBe(second);
    expect(SMOKING_PUNKS).toContain(first);
  });

  it('can assign different punks to different players', () => {
    resetAvatarAssignmentsForTests();
    const ids = new Set([
      avatarForPublicKey('player-a'),
      avatarForPublicKey('player-b'),
      avatarForPublicKey('player-c'),
    ]);
    expect(ids.size).toBeGreaterThan(1);
  });

  it('computes grid coords and fill offset for hover preview', () => {
    expect(punkGridCoords(0)).toEqual({ x: 0, y: 0 });
    expect(punkGridCoords(142)).toEqual({ x: 42, y: 1 });
    expect(punkSpriteFillStyle(142, 180)).toContain('width:18000px');
    expect(punkSpriteFillStyle(142, 180)).toContain('transform:translate(calc(-1 * 42 * 180px), calc(-1 * 1 * 180px))');
  });
});
