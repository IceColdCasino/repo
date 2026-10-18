export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3847';

export type ServerConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'starting';

export interface ServerHealth {
  ok: boolean;
  bootId?: string;
  backends?: string[];
}

export interface StartServerResult {
  ok: boolean;
  spawned?: boolean;
  alreadyRunning?: boolean;
  port?: number;
  error?: string;
}

const API_BASE_STORAGE_KEY = 'poker-api-base';

/** Set from zk.ping dylibLoad.platform (7 = iOS, 0 = desktop). */
const IOS_NATIVE_PLATFORM_CODE = 7;
let nativePlatformCode: number | null = null;

function hasNativeBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.zero?.invoke === 'function';
}

export function noteNativePlatform(platform: number): void {
  nativePlatformCode = platform;
}

function uaLooksLikeIos(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isIosNativeShell(): boolean {
  if (!hasNativeBridge()) {
    return false;
  }
  if (nativePlatformCode === IOS_NATIVE_PLATFORM_CODE) {
    return true;
  }
  if (nativePlatformCode !== null) {
    return false;
  }
  return uaLooksLikeIos();
}

/** macOS / Linux / Windows zero-native shell (not browser, not iOS WebView). */
export function isNativeDesktopShell(): boolean {
  return hasNativeBridge() && !isIosNativeShell();
}

/** True when the page was opened by a native E2E harness before window.zero is injected. */
export function nativeShellLikely(): boolean {
  if (hasNativeBridge()) {
    return true;
  }
  if (typeof window === 'undefined') {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('nativeE2e') === '1' || params.get('manualSetup') === '1';
}

function configuredApiBase(): string | null {
  const envBase = import.meta.env.VITE_API_BASE;
  if (typeof envBase === 'string' && envBase.trim().length > 0) {
    return envBase.trim().replace(/\/$/, '');
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = localStorage.getItem(API_BASE_STORAGE_KEY);
  if (stored && stored.trim().length > 0) {
    return stored.trim().replace(/\/$/, '');
  }
  return null;
}

export function saveApiBase(baseUrl: string): void {
  localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl.replace(/\/$/, ''));
}

export function loadApiBase(): string | null {
  return configuredApiBase();
}

/**
 * Base URL for game-server HTTP + SSE.
 * - iOS native shell: configured remote API (VITE_API_BASE or saved setting).
 * - Desktop native shell: already-running localhost game server (the app never launches Bun).
 * - Browser on Vite dev port: same-origin proxy to a host-started game server.
 */
export function resolveApiBase(baseUrl = DEFAULT_SERVER_URL): string {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryBase = params.get('apiBase') ?? params.get('e2eApiBase');
    if (queryBase?.trim()) {
      return queryBase.trim().replace(/\/$/, '');
    }
    const launchApi = (window as Window & { __ZK_LAUNCH_CONFIG?: { apiBase?: string } }).__ZK_LAUNCH_CONFIG?.apiBase;
    if (typeof launchApi === 'string' && launchApi.trim()) {
      return launchApi.trim().replace(/\/$/, '');
    }
  }
  if (isIosNativeShell()) {
    return configuredApiBase() ?? baseUrl.replace(/\/$/, '');
  }
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('nativeE2e') === '1' || params.get('manualSetup') === '1') {
      return baseUrl.replace(/\/$/, '');
    }
  }
  if (hasNativeBridge()) {
    return baseUrl.replace(/\/$/, '');
  }
  if (typeof window !== 'undefined' && window.location.port === '5173') {
    return window.location.origin;
  }
  return baseUrl.replace(/\/$/, '');
}

function resolveHealthUrl(baseUrl = DEFAULT_SERVER_URL): string {
  return `${resolveApiBase(baseUrl)}/api/health`;
}

async function fetchHttpHealth(healthUrl: string, timeoutMs = 3000): Promise<ServerHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (res.ok) {
      return (await res.json()) as ServerHealth;
    }
  } catch {
    // WebView fetch to localhost can fail briefly while the server is starting.
  } finally {
    clearTimeout(timer);
  }
  return null;
}

export interface NativeBridgeHealth {
  ok?: boolean;
  port?: number;
}

export async function fetchNativeBridgeHealth(): Promise<ServerHealth | null> {
  if (!hasNativeBridge()) {
    return null;
  }
  try {
    const bridge = await Promise.race([
      window.zero.invoke<NativeBridgeHealth>('server.health', {}),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('server.health bridge timeout')), 2000);
      }),
    ]);
    if (bridge?.ok) {
      return { ok: true };
    }
  } catch {
    // Bridge invoke can hang during WKWebView startup; caller falls back to HTTP polling.
  }
  return null;
}

export async function fetchServerHealth(baseUrl = DEFAULT_SERVER_URL): Promise<ServerHealth | null> {
  const healthUrl = resolveHealthUrl(baseUrl);

  if (isNativeDesktopShell()) {
    const httpHealth = await fetchHttpHealth(healthUrl, 2000);
    if (httpHealth?.ok) {
      return httpHealth;
    }
    return fetchNativeBridgeHealth();
  }

  const httpHealth = await fetchHttpHealth(healthUrl, 4000);
  if (httpHealth?.ok) {
    return httpHealth;
  }
  return fetchNativeBridgeHealth();
}

export async function isServerConnected(baseUrl = DEFAULT_SERVER_URL): Promise<boolean> {
  const health = await fetchServerHealth(baseUrl);
  return health?.ok === true;
}

export async function startLocalServer(): Promise<StartServerResult> {
  return {
    ok: false,
    error: 'The app does not launch Bun. Start the game server on the host, then Connect.',
  };
}

export async function waitForServerConnection(
  baseUrl = DEFAULT_SERVER_URL,
  timeoutMs = 30_000,
  intervalMs = 400,
): Promise<ServerHealth | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchServerHealth(baseUrl);
    if (health?.ok === true) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export function hasNativeServerLauncher(): boolean {
  return false;
}

// --- Optional Solana chain worker (:3850) — bootstrap only; play uses RPC events ---

export const DEFAULT_CHAIN_WORKER_URL = 'http://127.0.0.1:3850';

export interface ChainWorkerHealthResult {
  ok: boolean;
  worker?: boolean;
  localnetReady?: boolean;
  sessionReady?: boolean;
  hint?: string;
  error?: string;
}

export interface StartChainWorkerResult {
  ok: boolean;
  spawned?: boolean;
  alreadyRunning?: boolean;
  port?: number;
  error?: string;
}

export function resolveChainWorkerUrl(baseUrl = DEFAULT_CHAIN_WORKER_URL): string {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryBase =
      params.get('chainWorker')
      ?? params.get('chainWorkerBase')
      ?? params.get('apiBase')
      ?? params.get('e2eApiBase');
    if (queryBase?.trim()) {
      return queryBase.trim().replace(/\/$/, '');
    }
    const launch = (window as Window & {
      __ZK_LAUNCH_CONFIG?: { apiBase?: string; chainWorker?: string };
    }).__ZK_LAUNCH_CONFIG;
    const launchBase = launch?.chainWorker ?? launch?.apiBase;
    if (typeof launchBase === 'string' && launchBase.trim()) {
      return launchBase.trim().replace(/\/$/, '');
    }
    const envBase = import.meta.env.VITE_CHAIN_WORKER_URL;
    if (typeof envBase === 'string' && envBase.trim()) {
      return envBase.trim().replace(/\/$/, '');
    }
  }
  return baseUrl.replace(/\/$/, '');
}

async function fetchChainWorkerHttpHealth(
  baseUrl = DEFAULT_CHAIN_WORKER_URL,
  timeoutMs = 3000,
): Promise<ChainWorkerHealthResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${resolveChainWorkerUrl(baseUrl)}/api/health`, {
      signal: controller.signal,
    });
    if (res.ok) {
      return (await res.json()) as ChainWorkerHealthResult;
    }
  } catch {
    // Worker may still be starting.
  } finally {
    clearTimeout(timer);
  }
  return null;
}

export async function fetchNativeChainWorkerHealth(): Promise<ChainWorkerHealthResult | null> {
  if (!hasNativeBridge()) {
    return null;
  }
  try {
    const bridge = await Promise.race([
      window.zero.invoke<{ ok?: boolean; port?: number }>('chainWorker.health', {}),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('chainWorker.health bridge timeout')), 2000);
      }),
    ]);
    if (bridge?.ok) {
      return { ok: true, worker: true };
    }
  } catch {
    // fall through
  }
  return null;
}

export async function fetchChainWorkerHealth(
  baseUrl = DEFAULT_CHAIN_WORKER_URL,
): Promise<ChainWorkerHealthResult | null> {
  const http = await fetchChainWorkerHttpHealth(baseUrl);
  if (http?.ok) {
    return http;
  }
  return fetchNativeChainWorkerHealth();
}

export async function startChainWorker(): Promise<StartChainWorkerResult> {
  return {
    ok: false,
    error: 'The app does not launch Bun. Start the chain worker on the host if you need it.',
  };
}

export async function waitForChainWorker(
  baseUrl = DEFAULT_CHAIN_WORKER_URL,
  timeoutMs = 30_000,
  intervalMs = 400,
): Promise<ChainWorkerHealthResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchChainWorkerHealth(baseUrl);
    if (health?.ok === true) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export function hasNativeChainWorkerLauncher(): boolean {
  return hasNativeServerLauncher();
}
