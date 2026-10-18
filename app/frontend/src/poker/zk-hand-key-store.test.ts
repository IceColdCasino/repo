import { describe, expect, it, beforeEach, vi } from 'vitest';
import { stableInstanceId } from '../identity/instance-id';
import {
  clearZkHandKey,
  findZkHandKeyForPublicKey,
  loadZkHandKey,
  persistZkHandKey,
} from './zk-hand-key-store';

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  vi.stubGlobal('window', { location: { search: '?seat=3' } });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
      get length() {
        return memory.size;
      },
      key: (index: number) => [...memory.keys()][index] ?? null,
    },
  });
});

describe('zk-hand-key-store', () => {
  it('persists and restores ElGamal keys per hand number', () => {
    const key = {
      privateKey: 12345n,
      publicKey: [67890n, 11111n] as [bigint, bigint],
    };
    persistZkHandKey(3, key);
    expect(loadZkHandKey(3)).toEqual(key);
    expect(loadZkHandKey(4)).toBeNull();
  });

  it('clears stored keys', () => {
    persistZkHandKey(1, { privateKey: 1n, publicKey: [2n, 3n] });
    clearZkHandKey(1);
    expect(loadZkHandKey(1)).toBeNull();
  });

  it('scopes storage keys to the stable instance id', () => {
    persistZkHandKey(2, { privateKey: 9n, publicKey: [8n, 7n] });
    expect([...memory.keys()]).toEqual([
      `zk-hand-elgamal-key:${stableInstanceId()}:2`,
    ]);
  });

  it('also writes a per-seat copy so two windows cannot clobber each other', () => {
    const key = { privateKey: 9n, publicKey: [8n, 7n] as [bigint, bigint] };
    persistZkHandKey(2, key, 1);
    expect(loadZkHandKey(2, 1)).toEqual(key);
    expect([...memory.keys()]).toEqual(expect.arrayContaining([
      `zk-hand-elgamal-key:${stableInstanceId()}:2`,
      'zk-hand-elgamal-key:seat-1:2',
    ]));
  });

  it('finds keys stored under older instance ids by public key', () => {
    const key = { privateKey: 5n, publicKey: [6n, 7n] as [bigint, bigint] };
    memory.set('zk-hand-elgamal-key:old-instance:4', JSON.stringify({
      privateKey: key.privateKey.toString(),
      publicKey: key.publicKey.map((value) => value.toString()),
    }));
    expect(findZkHandKeyForPublicKey(4, key.publicKey)).toEqual(key);
    expect(loadZkHandKey(4)).toEqual(key);
  });
});
