/**
 * Dual-native shared meta: Zig `solana.meta` reads/writes `.local/*.json` (base64).
 * Falls back to localStorage when the native bridge is absent.
 *
 * Critical: two native processes coordinate hand progress via disk. Writes must be
 * flushed before the peer refreshes, and `shared-hand` mask bits must be OR-merged
 * so parallel register/shuffle/share cannot clobber each other.
 */
import {
  createLocalStorageMetaStore,
  setSharedMetaStore,
  type SharedMetaKey,
  type SharedMetaStore,
} from '@poker-src/chain/shared-meta-store';

type MetaResponse = {
  ok?: boolean;
  value?: string | null;
  encoding?: string;
  error?: string;
};

type HandMetaLike = {
  gameIdHex?: string;
  registeredMask?: number;
  shuffledMask?: number;
  sharedMask?: number;
  elGamalPublicKeys?: Array<[string, string] | null | undefined>;
  [key: string]: unknown;
};

function hasMetaBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.zero?.invoke === 'function';
}

function bytesToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function metaInvoke(payload: {
  action: 'get' | 'set' | 'remove';
  key: string;
  value?: string;
}): Promise<MetaResponse> {
  const invoke = window.zero?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('solana.meta bridge unavailable');
  }
  // Never block gameplay forever if the native bridge stalls.
  const raw = await Promise.race([
    invoke.call(window.zero, 'solana.meta', payload) as Promise<MetaResponse>,
    new Promise<MetaResponse>((_, reject) => {
      setTimeout(() => reject(new Error('solana.meta timed out (3s)')), 3_000);
    }),
  ]);
  if (raw && typeof raw === 'object' && typeof raw.error === 'string') {
    throw new Error(raw.error);
  }
  return raw ?? {};
}

/** OR mask bits + fill missing ElGamal keys so parallel seat writes cannot drop peers. */
export function mergeSharedHandMetaJson(local: string | null, incoming: string): string {
  if (!local) return incoming;
  let a: HandMetaLike;
  let b: HandMetaLike;
  try {
    a = JSON.parse(local) as HandMetaLike;
    b = JSON.parse(incoming) as HandMetaLike;
  } catch {
    return incoming;
  }
  if (
    typeof a.gameIdHex === 'string'
    && typeof b.gameIdHex === 'string'
    && a.gameIdHex !== b.gameIdHex
  ) {
    // Different hand — prefer incoming (fresh beginHand).
    return incoming;
  }
  const n = Math.max(
    Array.isArray(a.elGamalPublicKeys) ? a.elGamalPublicKeys.length : 0,
    Array.isArray(b.elGamalPublicKeys) ? b.elGamalPublicKeys.length : 0,
    typeof a.numPlayers === 'number' ? a.numPlayers : 0,
    typeof b.numPlayers === 'number' ? b.numPlayers : 0,
  );
  const keys: Array<[string, string] | null> = Array.from({ length: n }, () => null);
  const fill = (src: HandMetaLike['elGamalPublicKeys']) => {
    if (!Array.isArray(src)) return;
    for (let i = 0; i < src.length; i++) {
      const k = src[i];
      if (k && typeof k[0] === 'string' && typeof k[1] === 'string') {
        keys[i] = [k[0], k[1]];
      }
    }
  };
  // Incoming first, then local fills gaps (and vice versa via second pass).
  fill(b.elGamalPublicKeys);
  fill(a.elGamalPublicKeys);
  const merged: HandMetaLike = {
    ...a,
    ...b,
    registeredMask: (Number(a.registeredMask) || 0) | (Number(b.registeredMask) || 0),
    shuffledMask: (Number(a.shuffledMask) || 0) | (Number(b.shuffledMask) || 0),
    sharedMask: (Number(a.sharedMask) || 0) | (Number(b.sharedMask) || 0),
    elGamalPublicKeys: keys,
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Install the active SharedMetaStore for WebView Solana ops.
 * Call `refreshWebViewMetaCache()` before ops that need dual-client hand/table meta.
 */
export function installWebViewMetaStore(): SharedMetaStore {
  if (!hasMetaBridge()) {
    const local = createLocalStorageMetaStore();
    setSharedMetaStore(local);
    return local;
  }

  const cache = new Map<string, string>();
  const pendingWrites = new Map<string, Promise<void>>();

  const flushWrites = async (): Promise<void> => {
    const pending = [...pendingWrites.values()];
    if (pending.length > 0) {
      // Never fail the gameplay path because a disk mirror write failed —
      // in-memory cache remains authoritative for this WebView.
      await Promise.allSettled(pending);
    }
  };

  const refreshFromDisk = async (
    keys: SharedMetaKey[] = ['shared-table', 'shared-hand'],
  ): Promise<void> => {
    await flushWrites();
    for (const key of keys) {
      try {
        const raw = await metaInvoke({ action: 'get', key });
        if (typeof raw.value !== 'string') continue;
        const text = raw.encoding === 'base64' ? base64ToText(raw.value) : raw.value;
        if (key === 'shared-hand') {
          const merged = mergeSharedHandMetaJson(cache.get(key) ?? null, text);
          cache.set(key, merged);
        } else {
          cache.set(key, text);
        }
      } catch {
        // missing key
      }
    }
  };

  const store: SharedMetaStore & {
    __cacheSet?: (k: string, v: string) => void;
    flushWrites?: () => Promise<void>;
    refreshFromDisk?: (keys?: SharedMetaKey[]) => Promise<void>;
  } = {
    read(key) {
      return cache.has(key) ? cache.get(key)! : null;
    },
    write(key, data) {
      const next = key === 'shared-hand'
        ? mergeSharedHandMetaJson(cache.get(key) ?? null, data)
        : data;
      cache.set(key, next);
      const writePromise = metaInvoke({
        action: 'set',
        key,
        value: bytesToBase64(next),
      })
        .then(() => undefined)
        .catch((err) => {
          // Keep cache; do not reject — flushWrites must not block join/register.
          console.error('[solana.meta] set failed', key, err);
        })
        .finally(() => {
          if (pendingWrites.get(key) === writePromise) {
            pendingWrites.delete(key);
          }
        });
      pendingWrites.set(key, writePromise);
    },
    remove(key) {
      cache.delete(key);
      const removePromise = metaInvoke({ action: 'remove', key })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          if (pendingWrites.get(key) === removePromise) {
            pendingWrites.delete(key);
          }
        });
      pendingWrites.set(key, removePromise);
    },
    __cacheSet(k, v) {
      cache.set(k, v);
    },
    flushWrites,
    refreshFromDisk,
  };

  setSharedMetaStore(store);
  return store;
}

/** Pull shared-table / shared-hand into the sync cache from native files. */
export async function refreshWebViewMetaCache(
  keys: SharedMetaKey[] = ['shared-table', 'shared-hand'],
): Promise<void> {
  if (!hasMetaBridge()) return;
  const { getSharedMetaStore } = await import('@poker-src/chain/shared-meta-store');
  const store = getSharedMetaStore() as SharedMetaStore & {
    refreshFromDisk?: (keys?: SharedMetaKey[]) => Promise<void>;
    __cacheSet?: (k: string, v: string) => void;
    flushWrites?: () => Promise<void>;
  };
  if (typeof store.refreshFromDisk === 'function') {
    await store.refreshFromDisk(keys);
    return;
  }
  // Legacy path (tests / partial installs).
  if (typeof store.flushWrites === 'function') {
    await store.flushWrites();
  }
  for (const key of keys) {
    try {
      const raw = await metaInvoke({ action: 'get', key });
      if (typeof raw.value === 'string' && store.__cacheSet) {
        const text = raw.encoding === 'base64' ? base64ToText(raw.value) : raw.value;
        store.__cacheSet(key, text);
      }
    } catch {
      // missing key
    }
  }
}

/** Wait for in-flight `solana.meta` set/remove ops (no-op without bridge). */
export async function flushWebViewMetaWrites(): Promise<void> {
  if (!hasMetaBridge()) return;
  const { getSharedMetaStore } = await import('@poker-src/chain/shared-meta-store');
  const store = getSharedMetaStore() as SharedMetaStore & {
    flushWrites?: () => Promise<void>;
  };
  if (typeof store.flushWrites === 'function') {
    await store.flushWrites();
  }
}
