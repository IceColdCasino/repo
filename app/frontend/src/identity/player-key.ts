import { Keypair } from '@solana/web3.js';
import type { BackendKind } from '../backend/client';
import { stableInstanceId } from './instance-id';

/**
 * Per-instance wallet.
 *
 * Native dual clients share one WKWebView localStorage origin — never store
 * seat wallets there. Use sessionStorage only (per-process). Gameplay does not
 * round-trip wallets through solana.meta / `.local/` files.
 */
const SESSION_SECRET_STORAGE_KEY = 'poker-local-player-secret';

function e2eSeatFromUrl(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('e2eSeat') ?? params.get('seat');
  if (raw === null || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

function isNativeE2e(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('nativeE2e') === '1';
}

function wantsNewWalletParam(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('wallet') === 'new'
    || params.get('player') === 'new'
    || params.get('e2eWallet') === 'new';
}

function walletStorageKey(): string {
  const seat = e2eSeatFromUrl();
  if (isNativeE2e() && seat !== null) {
    return `${SESSION_SECRET_STORAGE_KEY}:e2e-seat-${seat}`;
  }
  return `${SESSION_SECRET_STORAGE_KEY}:${stableInstanceId()}`;
}

function persistSession(keypair: Keypair): void {
  if (typeof window === 'undefined') {
    return;
  }
  sessionStorage.setItem(
    walletStorageKey(),
    JSON.stringify(Array.from(keypair.secretKey)),
  );
}

/**
 * Dual-mac Solana E2E: persist seat wallet to `.local/e2e-wallet-seatN.json` so a
 * host Bun ZK driver can register/shuffle/share when WKWebView App-Naps.
 */
async function persistMeta(keypair: Keypair): Promise<void> {
  const seat = e2eSeatFromUrl();
  if (!isNativeE2e() || seat === null) {
    return;
  }
  try {
    const { installWebViewMetaStore, flushWebViewMetaWrites } = await import(
      '../backend/solana-meta-bridge'
    );
    const store = installWebViewMetaStore();
    store.write(
      `e2e-wallet-seat${seat}`,
      JSON.stringify({
        publicKey: keypair.publicKey.toBase58(),
        secretKey: Array.from(keypair.secretKey),
      }),
    );
    await flushWebViewMetaWrites();
  } catch {
    // Meta bridge optional in browser.
  }
}

function keypairFromSecretJson(raw: string): Keypair | null {
  try {
    const secret = Uint8Array.from(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

/**
 * Formerly hydrated from solana.meta disk. Gameplay no longer uses file IPC —
 * sessionStorage (already loaded via getOrCreate) is enough for a process.
 */
export async function hydrateE2eWalletFromMeta(): Promise<string | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  // Ensure session wallet exists without touching solana.meta.
  return getOrCreateLocalPublicKey();
}

function loadLocalKeypair(): Keypair {
  if (typeof window === 'undefined') {
    return Keypair.generate();
  }

  const key = walletStorageKey();
  // e2eWallet=new must not wipe a hydrated disk wallet mid-hand.
  if (wantsNewWalletParam() && !sessionStorage.getItem(key) && !cachedKeypair) {
    // Allow mint below when nothing persisted yet.
  } else if (wantsNewWalletParam() && !isNativeE2e()) {
    sessionStorage.removeItem(key);
  }

  if (cachedKeypair) {
    return cachedKeypair;
  }

  const stored = sessionStorage.getItem(key);
  if (stored) {
    const fromSession = keypairFromSecretJson(stored);
    if (fromSession) {
      return fromSession;
    }
    sessionStorage.removeItem(key);
  }

  const keypair = Keypair.generate();
  persistSession(keypair);
  void persistMeta(keypair).catch(() => undefined);
  return keypair;
}

let cachedLocalPublicKey: string | null = null;
let cachedKeypair: Keypair | null = null;

export function shortPublicKey(publicKey: string): string {
  if (publicKey.length <= 10) {
    return publicKey;
  }
  return `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

export function getOrCreateLocalPublicKey(): string {
  if (!cachedLocalPublicKey) {
    cachedKeypair = loadLocalKeypair();
    cachedLocalPublicKey = cachedKeypair.publicKey.toBase58();
    void persistMeta(cachedKeypair).catch(() => undefined);
  }
  return cachedLocalPublicKey;
}

/** Secret key bytes for native solana.op per-seat signing (localnet only). */
export function getLocalSecretKeyBytes(): number[] {
  if (!cachedKeypair) {
    cachedKeypair = loadLocalKeypair();
    cachedLocalPublicKey = cachedKeypair.publicKey.toBase58();
  }
  return Array.from(cachedKeypair.secretKey);
}

/** Generate a fresh wallet for this browser instance (multi-player testing). */
export function createNewLocalWallet(): string {
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(walletStorageKey());
  }
  cachedKeypair = Keypair.generate();
  persistSession(cachedKeypair);
  void persistMeta(cachedKeypair).catch(() => undefined);
  cachedLocalPublicKey = cachedKeypair.publicKey.toBase58();
  return cachedLocalPublicKey;
}

/** Solana wallet adapter hook — replace with real wallet integration. */
export function getWalletPublicKey(): string | null {
  const provider = (window as Window & {
    solana?: { publicKey?: { toBase58(): string }; isPhantom?: boolean };
  }).solana;
  return provider?.publicKey?.toBase58() ?? null;
}

export function getActivePublicKey(_backend: BackendKind): string {
  return getOrCreateLocalPublicKey();
}

export function resetLocalPublicKeyCacheForTests(): void {
  cachedLocalPublicKey = null;
  cachedKeypair = null;
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(walletStorageKey());
  }
}
