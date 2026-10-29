import { Keypair } from '@solana/web3.js';
import type { BackendKind } from '../backend/client';
import { stableInstanceId } from './instance-id';
import { connectedAddress } from './wallet-standard';

/**
 * Per-instance wallet.
 *
 * Native dual clients share one WKWebView localStorage origin — never store
 * seat wallets there. Use sessionStorage only (per-process). Gameplay does not
 * round-trip wallets through solana.meta / `.local/` files.
 */
const SESSION_SECRET_STORAGE_KEY = 'poker-local-player-secret';

function seatNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

function e2eSeatFromUrl(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  return seatNumber(params.get('e2eSeat') ?? params.get('seat'));
}

function launchSeat(): number | null {
  const fromUrl = e2eSeatFromUrl();
  if (fromUrl !== null) {
    return fromUrl;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const seat = (window as Window & { __ZK_LAUNCH_CONFIG?: { seat?: number } }).__ZK_LAUNCH_CONFIG?.seat;
  return seatNumber(seat);
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
  const seat = launchSeat();
  if (seat === null || typeof window === 'undefined' || typeof window.zero?.invoke !== 'function') {
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

async function readPersistedSeatWallet(): Promise<Keypair | null> {
  const seat = launchSeat();
  if (seat === null || typeof window === 'undefined' || typeof window.zero?.invoke !== 'function') {
    return null;
  }
  try {
    const { installWebViewMetaStore } = await import('../backend/solana-meta-bridge');
    const store = installWebViewMetaStore() as {
      read(key: string): string | null;
      refreshFromDisk?(keys?: string[]): Promise<void>;
    };
    const key = `e2e-wallet-seat${seat}`;
    await store.refreshFromDisk?.([key]);
    const raw = store.read(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { secretKey?: number[] };
    if (!Array.isArray(parsed.secretKey)) {
      return null;
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey));
  } catch {
    return null;
  }
}

/**
 * Reuse this seat's already-whitelisted wallet. Session storage wins for the
 * live process; a fresh process loads `.local/e2e-wallet-seatN` before minting.
 */
export async function hydrateE2eWalletFromMeta(): Promise<string | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = sessionStorage.getItem(walletStorageKey());
  if (stored) {
    const fromSession = keypairFromSecretJson(stored);
    if (fromSession) {
      cachedKeypair = fromSession;
      cachedLocalPublicKey = fromSession.publicKey.toBase58();
      return cachedLocalPublicKey;
    }
  }
  const fromDisk = await readPersistedSeatWallet();
  if (fromDisk) {
    cachedKeypair = fromDisk;
    cachedLocalPublicKey = fromDisk.publicKey.toBase58();
    persistSession(fromDisk);
    void persistMeta(fromDisk).catch(() => undefined);
    return cachedLocalPublicKey;
  }
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

/** Automated seat runs keep a local key. A person connects a Wallet Standard wallet. */
export function usesLocalSeatKey(): boolean {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  if (
    params.get('nativeE2e') === '1'
    || params.get('e2eSeat') != null
    || params.get('iosE2eFullGame') === '1'
  ) {
    return true;
  }
  const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE;
  return mode === 'test';
}

export function getActivePublicKey(_backend: BackendKind): string {
  if (!usesLocalSeatKey()) {
    return connectedAddress();
  }
  return getOrCreateLocalPublicKey();
}

export function resetLocalPublicKeyCacheForTests(): void {
  cachedLocalPublicKey = null;
  cachedKeypair = null;
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(walletStorageKey());
  }
}
