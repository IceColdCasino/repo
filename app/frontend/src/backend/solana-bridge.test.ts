import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSharedMeta, setSharedMetaStore } from '@poker-src/chain/shared-meta-store';
import {
  preferSolanaCliOps,
  hasSolanaOpBridge,
  resolveLaunchTableMeta,
  resetSolanaBridgeMetaForTest,
  invokeSolanaOp,
} from './solana-bridge';

vi.mock('@poker-src/chain/per-seat-ops', () => ({
  executePerSeatOp: vi.fn(async () => ({})),
}));

describe('solana-bridge', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    delete (window as { __ZK_LAUNCH_CONFIG?: unknown }).__ZK_LAUNCH_CONFIG;
    delete (window as { zero?: unknown }).zero;
    resetSolanaBridgeMetaForTest();
    setSharedMetaStore({
      read: () => null,
      write: () => undefined,
    });
  });

  it('preferSolanaCliOps is off by default', () => {
    expect(preferSolanaCliOps()).toBe(false);
  });

  it('preferSolanaCliOps stays off even when query or launch config ask for CLI', () => {
    window.history.replaceState({}, '', '/?solanaCliOps=1');
    expect(preferSolanaCliOps()).toBe(false);
    window.history.replaceState({}, '', '/');
    (window as { __ZK_LAUNCH_CONFIG?: { solanaCliOps?: boolean } }).__ZK_LAUNCH_CONFIG = {
      solanaCliOps: true,
    };
    expect(preferSolanaCliOps()).toBe(false);
  });

  it('hasSolanaOpBridge detects window.zero.invoke', () => {
    expect(hasSolanaOpBridge()).toBe(false);
    (window as { zero?: { invoke: () => Promise<unknown> } }).zero = {
      invoke: vi.fn(async () => ({})),
    };
    expect(hasSolanaOpBridge()).toBe(true);
  });

  it('resolveLaunchTableMeta reads launch-config then URL', () => {
    expect(resolveLaunchTableMeta()).toBeNull();
    (window as { __ZK_LAUNCH_CONFIG?: { roomSeed: string; tableId: string } }).__ZK_LAUNCH_CONFIG = {
      roomSeed: 'zk-poker-share-localnet-v2-g3',
      tableId: '19',
    };
    expect(resolveLaunchTableMeta()).toEqual({
      roomSeed: 'zk-poker-share-localnet-v2-g3',
      tableId: '19',
      roomIdHex: undefined,
    });
    delete (window as { __ZK_LAUNCH_CONFIG?: unknown }).__ZK_LAUNCH_CONFIG;
    window.history.replaceState({}, '', '/?roomSeed=seed-a&tableId=7&roomIdHex=ab');
    expect(resolveLaunchTableMeta()).toEqual({
      roomSeed: 'seed-a',
      tableId: '7',
      roomIdHex: 'ab',
    });
  });

  it('seeds shared-table from launch meta even if meta store was already installed empty', async () => {
    const map = new Map<string, string>();
    setSharedMetaStore({
      read: (key) => map.get(String(key)) ?? null,
      write: (key, value) => {
        map.set(String(key), value);
      },
    });
    await invokeSolanaOp({ op: 'snapshot' });
    expect(readSharedMeta('shared-table')).toBeNull();

    (window as { __ZK_LAUNCH_CONFIG?: { roomSeed: string; tableId: string } }).__ZK_LAUNCH_CONFIG = {
      roomSeed: 'late-room-seed',
      tableId: '42',
    };
    await invokeSolanaOp({ op: 'snapshot' });

    expect(JSON.parse(readSharedMeta('shared-table') ?? '{}')).toMatchObject({
      roomSeed: 'late-room-seed',
      tableId: '42',
    });
  });

  it('replaces a stored table from a different room with the launched table', async () => {
    const map = new Map<string, string>();
    map.set('shared-table', JSON.stringify({
      roomSeed: 'zk-poker-share-localnet-v2-g3',
      tableId: '1',
    }));
    setSharedMetaStore({
      read: (key) => map.get(String(key)) ?? null,
      write: (key, value) => {
        map.set(String(key), value);
      },
    });
    (window as { __ZK_LAUNCH_CONFIG?: { roomSeed: string; tableId: string } }).__ZK_LAUNCH_CONFIG = {
      roomSeed: 'zk-poker-share-localnet-v2',
      tableId: '0',
    };
    await invokeSolanaOp({ op: 'snapshot' });
    expect(JSON.parse(readSharedMeta('shared-table') ?? '{}')).toMatchObject({
      roomSeed: 'zk-poker-share-localnet-v2',
      tableId: '0',
    });
  });
});
