import { describe, expect, it } from 'vitest';
import { preloadCircuits } from './browser-circuits';
import { Player } from '@poker-src/poker-player';

describe('browser poker player with assert shim', () => {
  it('generates keys and reaches registerProve without assert import errors', async () => {
    const circuits = await preloadCircuits();
    const player = new Player(circuits);
    await player.init();
    player.generateKey();
    expect(player.publicKey[0]).toBeTypeOf('bigint');
    expect(player.publicKey[1]).toBeTypeOf('bigint');
    expect(player.publicKey[0]).toBeGreaterThan(0n);
  });
});
