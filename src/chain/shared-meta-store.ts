/**
 * Shared table/hand coordination store.
 *
 * Node CLI: filesystem under `.local/`.
 * Dual native WebViews: `solana.meta` Zig bridge (same `.local/` files).
 * Plain browser: localStorage (single-tab only).
 */

export type SharedMetaKey = 'shared-table' | 'shared-hand' | string;

export interface SharedMetaStore {
  read(key: SharedMetaKey): string | null;
  write(key: SharedMetaKey, data: string): void;
  remove?(key: SharedMetaKey): void;
  /** WebView: wait for in-flight solana.meta disk writes. */
  flushWrites?(): Promise<void>;
  /** WebView: pull keys from `.local/` into the process cache (OR-merges hand masks). */
  refreshFromDisk?(keys?: SharedMetaKey[]): Promise<void>;
}

class MemoryMetaStore implements SharedMetaStore {
  private map = new Map<string, string>();
  read(key: SharedMetaKey): string | null {
    return this.map.get(key) ?? null;
  }
  write(key: SharedMetaKey, data: string): void {
    this.map.set(key, data);
  }
  remove(key: SharedMetaKey): void {
    this.map.delete(key);
  }
}

/** Survive Vite dual-bundle copies of this module (bridge vs per-seat-ops). */
const GLOBAL_STORE_KEY = '__zkPokerSharedMetaStore';

function getActiveStoreSlot(): { current: SharedMetaStore } {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_STORE_KEY]?: { current: SharedMetaStore };
  };
  if (!g[GLOBAL_STORE_KEY]) {
    g[GLOBAL_STORE_KEY] = { current: new MemoryMetaStore() };
  }
  return g[GLOBAL_STORE_KEY];
}

export function setSharedMetaStore(store: SharedMetaStore): void {
  getActiveStoreSlot().current = store;
}

export function getSharedMetaStore(): SharedMetaStore {
  return getActiveStoreSlot().current;
}

export function readSharedMeta(key: SharedMetaKey): string | null {
  return getSharedMetaStore().read(key);
}

export function writeSharedMeta(key: SharedMetaKey, data: string): void {
  getSharedMetaStore().write(key, data);
}

/** localStorage-backed store for single-tab browser play. */
export function createLocalStorageMetaStore(prefix = 'zk-solana-meta:'): SharedMetaStore {
  return {
    read(key) {
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    write(key, data) {
      localStorage.setItem(prefix + key, data);
    },
    remove(key) {
      localStorage.removeItem(prefix + key);
    },
  };
}
