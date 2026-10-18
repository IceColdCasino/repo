import { timeAsync, logTiming } from '@poker-src/timing-log';
import { reportZkHandError } from '../poker/zk-e2e-diagnostics';
import { emitProveEvent } from '../poker/prove-event-log';
import { resolveApiBase, isIosNativeShell, nativeShellLikely, noteNativePlatform } from '../server/runtime';
import { agentDebugLog } from '../debug-agent-log';
import { normalizeProveResult } from './normalize-prove-result';

export type ZkRuntimeKind = 'native-bridge' | 'unavailable';

export interface ZkProveResult {
  proof: object;
  publicSignals: string[];
}

export interface ZkProveRuntime {
  kind: ZkRuntimeKind;
  ping(): Promise<{ ok: boolean; detail?: string }>;
  prove(circuitName: string, input: Record<string, string | string[]>): Promise<ZkProveResult>;
}

function hasNativeBridge(): boolean {
  const hasWin = typeof window !== 'undefined';
  const z = hasWin ? (window as any).zero : undefined;
  const hasInvoke = !!(z && typeof z.invoke === 'function');
  const detail = hasWin
    ? { hasZero: !!z, invokeType: z ? typeof z.invoke : 'n/a', keys: z ? Object.keys(z) : [] }
    : { hasZero: false };
  const result = hasWin && hasInvoke;
  // Always log to console for capture in host process logs
  try {
    console.log('[BRIDGE hasNativeBridge]', JSON.stringify({ result, ...detail, t: (typeof performance !== 'undefined' ? performance.now() : Date.now()) }));
  } catch {}
  // Also record to global debug if present (populated by early inline script)
  try {
    const D = (window as any).__zkBridgeDebug;
    if (D && D.events) {
      D.events.push({
        t: ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()).toFixed(1) + 'ms',
        label: 'hasNativeBridge',
        result,
        ...detail,
      });
    }
  } catch {}
  return result;
}

/** Per-circuit native prove timeout (witness + Groth16). Share is ~8s on macOS, slower on iOS sim. */
function circuitProveTimeoutMs(circuitName: string): number {
  if (circuitName.includes('showdown')) {
    return 120_000;
  }
  if (circuitName.includes('share')) {
    return 60_000;
  }
  if (circuitName.includes('shuffle')) {
    return 45_000;
  }
  return 30_000;
}

/**
 * Wait for `window.zero.invoke('zk.prove')` to return the proof JSON directly.
 * No prove-result.json / HTTP file poll — bridge response is the only channel.
 */
async function waitForNativeProveResult(
  invokePromise: Promise<ZkProveResult>,
  proveTimeoutMs: number,
): Promise<ZkProveResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Native prove timed out after ${proveTimeoutMs / 1000}s`)),
      proveTimeoutMs,
    );
  });
  try {
    return await Promise.race([invokePromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

class NativeBridgeRuntime implements ZkProveRuntime {
  kind: ZkRuntimeKind = 'native-bridge';

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const result = await window.zero.invoke<{
      ok: boolean;
      repoRoot?: string;
      libDir?: string;
      dylibLoad?: { ok: boolean; path?: string; loadError?: string; platform?: number };
    }>('zk.ping', {});
    if (typeof result.dylibLoad?.platform === 'number') {
      noteNativePlatform(result.dylibLoad.platform);
    }
    // Bridge is ready once invoke succeeds; dylib diagnostics are for logs only.
    if (result.dylibLoad && result.dylibLoad.ok === false) {
      console.warn(
        '[bridge] witness library probe:',
        result.dylibLoad.loadError ?? result.dylibLoad.path ?? 'load failed',
      );
    }
    return { ok: result.ok === true, detail: result.libDir ?? result.repoRoot };
  }

  async prove(circuitName: string, input: Record<string, string | string[]>): Promise<ZkProveResult> {
    const proveTimeoutMs = circuitProveTimeoutMs(circuitName);
    // ProveBusy should clear quickly; do not spin for minutes (was 240×500ms).
    const maxBusyRetries = 40;
    const busyDelayMs = 250;

    const bridgeErrorCode = (message: string): string | null => {
      try {
        const body = JSON.parse(message.trim()) as { error?: string };
        return typeof body.error === 'string' ? body.error : null;
      } catch {
        if (message.includes('ProveBusy')) return 'ProveBusy';
        if (message.includes('ProveDuplicate')) return 'ProveDuplicate';
        return null;
      }
    };

    const isRetryableBusy = (code: string | null) =>
      code === 'ProveBusy' || code === 'ProveDuplicate';

    for (let busyRetry = 0; ; busyRetry += 1) {
      // Combined native path: witness calc + Groth16 inside `zk.prove`.
      // Log once per attempt (skip ProveBusy spin so Event log does not flood).
      if (busyRetry === 0) {
        emitProveEvent('start', circuitName);
      }
      const t0 = Date.now();
      let terminalLogged = false;
      try {
        agentDebugLog('H1', 'runtime.ts:prove', 'invoke zk.prove start', {
          circuitName,
          busyRetry,
          inputKeys: Object.keys(input),
        });
        const invokePromise = window.zero.invoke<ZkProveResult>('zk.prove', { circuitName, input });
        const result = await timeAsync(`zk.prove ${circuitName}`, () =>
          waitForNativeProveResult(invokePromise, proveTimeoutMs),
        );
        const ms = Date.now() - t0;
        agentDebugLog('H1', 'runtime.ts:prove', 'invoke zk.prove resolved', {
          circuitName,
          ms,
          hasProof: Boolean(result?.proof),
          signalCount: Array.isArray(result?.publicSignals) ? result.publicSignals.length : 0,
        });
        if (
          result
          && typeof result === 'object'
          && 'error' in result
          && typeof (result as { error?: unknown }).error === 'string'
        ) {
          const code = (result as { error: string }).error;
          if (isRetryableBusy(code) && busyRetry < maxBusyRetries) {
            await new Promise((resolve) => setTimeout(resolve, busyDelayMs));
            continue;
          }
          emitProveEvent('failed', circuitName, { ms, error: code });
          terminalLogged = true;
          throw new Error(JSON.stringify({ error: code }));
        }
        // Prefer proofJson/publicSignalsJson (string-wrapped) so outer JSON.parse
        // cannot turn BN254 limbs into imprecise JS numbers.
        try {
          const normalized = normalizeProveResult(result);
          emitProveEvent('done', circuitName, { ms });
          return normalized;
        } catch (normErr) {
          const detail = normErr instanceof Error ? normErr.message : String(normErr);
          emitProveEvent('failed', circuitName, { ms, error: detail });
          terminalLogged = true;
          throw new Error(
            `Native bridge returned invalid prove result for ${circuitName}: ${detail}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ms = Date.now() - t0;
        agentDebugLog('H1', 'runtime.ts:prove', 'invoke zk.prove failed', {
          circuitName,
          message,
          busyRetry,
        });
        const code = bridgeErrorCode(message);
        if (isRetryableBusy(code) && busyRetry < maxBusyRetries) {
          await new Promise((resolve) => setTimeout(resolve, busyDelayMs));
          continue;
        }
        if (!terminalLogged) {
          emitProveEvent('failed', circuitName, { ms, error: code ?? message.slice(0, 160) });
        }
        await reportZkHandError({
          source: 'zk.bridge',
          phase: null,
          circuitName,
          message,
          stack: err instanceof Error ? err.stack : undefined,
          detail: { inputKeys: Object.keys(input) },
        });
        throw err;
      }
    }
  }
}

class UnavailableRuntime implements ZkProveRuntime {
  kind: ZkRuntimeKind = 'unavailable';

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      console.log('[BRIDGE UnavailableRuntime.ping] called (no window.zero.invoke at decision time)');
      const D = (window as any).__zkBridgeDebug;
      if (D) {
        D.events.push({ t: 'now', label: 'Unavailable.ping', note: 'bridge not present at ping time' });
      }
    } catch {}
    return {
      ok: false,
      detail: 'Bridge is not ready.',
    };
  }

  async prove(): Promise<ZkProveResult> {
    throw new Error('Bridge is not ready.');
  }
}

let cached: ZkProveRuntime | null = null;

const RUNTIME_CACHE_KEY = '__zkProveRuntimeCache';

function readSharedCache(): ZkProveRuntime | null {
  if (typeof window === 'undefined') {
    return cached;
  }
  return (window as unknown as Record<string, ZkProveRuntime | undefined>)[RUNTIME_CACHE_KEY] ?? cached;
}

function writeSharedCache(runtime: ZkProveRuntime | null): void {
  cached = runtime;
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, ZkProveRuntime | null | undefined>)[RUNTIME_CACHE_KEY] = runtime;
  }
}

function installBridgeCompleteHook(): void {
  // window.zero is Object.freeze()'d by zero-native — do not assign to _complete.
}

export function getZkRuntime(): ZkProveRuntime {
  const bridgeReady = hasNativeBridge();
  let runtime = readSharedCache();
  if (runtime) {
    if (runtime.kind === 'unavailable' && bridgeReady) {
      runtime = null;
      writeSharedCache(null);
    } else if (runtime.kind === 'native-bridge' && !bridgeReady) {
      runtime = null;
      writeSharedCache(null);
    }
  }
  if (runtime) {
    return runtime;
  }
  installBridgeCompleteHook();
  runtime = bridgeReady ? new NativeBridgeRuntime() : new UnavailableRuntime();
  writeSharedCache(runtime);
  return runtime;
}

export function resetZkRuntime(): void {
  writeSharedCache(null);
}

export async function pingZkRuntime(): Promise<{ ok: boolean; kind: ZkRuntimeKind; detail?: string }> {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const runtime = getZkRuntime();
  const beforeKind = runtime.kind;
  let pingRes: { ok: boolean; detail?: string };
  try {
    pingRes = await runtime.ping();
  } catch (e: any) {
    try { console.log('[BRIDGE pingZkRuntime] ping threw', String(e)); } catch {}
    return { ok: false, kind: beforeKind, detail: 'ping threw: ' + String(e) };
  }
  const dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
  try {
    console.log('[BRIDGE pingZkRuntime]', JSON.stringify({ beforeKind, ok: pingRes.ok, detail: pingRes.detail, dtMs: dt.toFixed(1) }));
  } catch {}
  // record to debug
  try {
    const D = (window as any).__zkBridgeDebug;
    if (D && D.events) {
      D.events.push({ t: dt.toFixed(1)+'ms-after', label: 'pingZkRuntime-result', ok: pingRes.ok, kind: beforeKind, detail: pingRes.detail });
    }
  } catch {}
  return { ...pingRes, kind: beforeKind };
}

const PING_TIMEOUT_MS = 30_000;
const STARTUP_PING_TIMEOUT_MS = 5_000;

/** How long to wait for window.zero + first successful ping on startup. */
export function nativeBridgeStartupTimeoutMs(): number {
  if (typeof window !== 'undefined' && isIosNativeShell()) {
    return 45_000;
  }
  if (nativeShellLikely()) {
    return 10_000;
  }
  return 15_000;
}

export async function tryRefreshNativeBridge(
  timeoutMs = PING_TIMEOUT_MS,
): Promise<{ ok: boolean; kind: ZkRuntimeKind; detail?: string }> {
  if (!hasNativeBridge()) {
    return {
      ok: false,
      kind: 'unavailable',
      detail: 'Bridge is not ready.',
    };
  }
  try {
    const result = await Promise.race([
      pingZkRuntime(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Native bridge ping timed out')), timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    return {
      ok: false,
      kind: 'native-bridge',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function waitForNativeBridge(
  timeoutMs = 20_000,
  intervalMs = 250,
  pingTimeoutMs = STARTUP_PING_TIMEOUT_MS,
): Promise<{ ok: boolean; kind: ZkRuntimeKind; detail?: string }> {
  resetZkRuntime();
  const deadline = Date.now() + timeoutMs;
  let lastDetail: string | undefined;
  while (Date.now() < deadline) {
    if (!hasNativeBridge()) {
      lastDetail = 'Bridge is not ready.';
    } else {
      try {
        const result = await Promise.race([
          pingZkRuntime(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Native bridge ping timed out')), pingTimeoutMs);
          }),
        ]);
        if (result.ok) {
          return result;
        }
        lastDetail = result.detail;
      } catch (err) {
        lastDetail = err instanceof Error ? err.message : String(err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    kind: hasNativeBridge() ? 'native-bridge' : 'unavailable',
    detail: lastDetail ?? 'Bridge is not ready.',
  };
}

const DEFAULT_VERIFY_BASE = resolveApiBase();

export async function verifyCircuit(
  circuitName: string,
  proof: object,
  publicSignals: string[],
  baseUrl = DEFAULT_VERIFY_BASE,
): Promise<boolean> {
  const apiBase = baseUrl || resolveApiBase();
  const res = await fetch(`${apiBase}/api/zk/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circuitName, proof, publicSignals }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  const body = await res.json();
  return body.valid === true;
}

export async function proveCircuit(
  circuitName: string,
  input: Record<string, string | string[]>,
): Promise<ZkProveResult> {
  return getZkRuntime().prove(circuitName, input);
}

const SHOWDOWN_ZKEY_CIRCUIT = 'poker_showdown_hashout_main';

/** Fire-and-forget: read showdown zkey into OS page cache during River betting. */
export async function warmShowdownZkeyPages(): Promise<{ ok: boolean; started?: boolean }> {
  if (!hasNativeBridge()) {
    return { ok: false };
  }
  try {
    const result = await window.zero.invoke<{ ok: boolean; started?: boolean }>('zk.warmZkey', {
      circuitName: SHOWDOWN_ZKEY_CIRCUIT,
    });
    if (result.started) {
      logTiming(`showdown zkey warm dispatched ${SHOWDOWN_ZKEY_CIRCUIT}`);
    }
    return result;
  } catch (err) {
    console.warn('[bridge] showdown zkey warm failed:', err instanceof Error ? err.message : err);
    return { ok: false };
  }
}
