import { describe, expect, it } from 'vitest';
import { isNativeE2e, loadE2eSeatHandKey } from './e2e-seat-hand-key';

describe('e2e-seat-hand-key parse helpers', () => {
  it('round-trips private/public key JSON shape used by host-zk', () => {
    const body = {
      privateKey: '12345678901234567890',
      publicKey: ['111', '222'] as [string, string],
    };
    const key = {
      privateKey: BigInt(body.privateKey),
      publicKey: [BigInt(body.publicKey[0]), BigInt(body.publicKey[1])] as [bigint, bigint],
    };
    expect(key.privateKey).toBe(12345678901234567890n);
    expect(key.publicKey).toEqual([111n, 222n]);
    const again = JSON.parse(JSON.stringify({
      privateKey: key.privateKey.toString(),
      publicKey: key.publicKey.map(String),
    })) as typeof body;
    expect(again.privateKey).toBe(body.privateKey);
    expect(again.publicKey).toEqual(body.publicKey);
  });
});

describe('loadE2eSeatHandKey isolation', () => {
  it('is a no-op unless nativeE2e=1 so leftover .local files cannot overwrite a live hand', async () => {
    const previous = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { search: '?backend=local&seat=0&instance=seat-0' } },
    });
    try {
      expect(isNativeE2e()).toBe(false);
      expect(await loadE2eSeatHandKey(1, 0)).toBeNull();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previous,
        });
      }
    }
  });
});
