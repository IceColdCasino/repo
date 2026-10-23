/**
 * Auto-setup for native WebView E2E when the real window.zero bridge is present.
 * Activated via URL: ?nativeE2e=1&e2eSeat=0  (add &e2eWallet=new for seat 1+)
 */
import { getOrCreateLocalPublicKey, hydrateE2eWalletFromMeta } from '../identity';
import { stableInstanceId } from '../identity/instance-id';
import { logTiming, timeAsync } from '@poker-src/timing-log';
import { waitForNativePlayerReady } from './native-crypto-prewarm';
import { agentDebugLog } from '../debug-agent-log';

export interface NativeE2eBootstrap {
  seat: number;
  newWallet: boolean;
  startHand: boolean;
  autoPlay: boolean;
}

export function readNativeE2eConfigFromUrl(): NativeE2eBootstrap | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const enabled = params.get('nativeE2e') === '1' || params.get('manualSetup') === '1';
  if (!enabled) {
    return null;
  }
  const seat = Number(params.get('e2eSeat') ?? params.get('seat'));
  if (!Number.isInteger(seat) || seat < 0 || seat > 9) {
    return null;
  }
  return {
    seat,
    newWallet: params.get('e2eWallet') === 'new' || params.get('wallet') === 'new',
    startHand: params.get('e2eStartHand') === '1',
    autoPlay: params.get('e2eAutoPlay') === '1',
  };
}

/** iOS harness: requires bridge before reading URL config. */
export function readNativeE2eBootstrap(): NativeE2eBootstrap | null {
  if (typeof window === 'undefined' || typeof window.zero?.invoke !== 'function') {
    return null;
  }
  return readNativeE2eConfigFromUrl();
}

/** Written by macOS native app at startup from ZK_LAUNCH_* (see app_core.zig). */
export function readNativeLaunchConfigFromWindow(): NativeE2eBootstrap | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const cfg = (window as Window & {
    __ZK_LAUNCH_CONFIG?: {
      manualSetup?: boolean;
      seat?: number;
      newWallet?: boolean;
      startHand?: boolean;
      autoPlay?: boolean;
    };
  }).__ZK_LAUNCH_CONFIG;
  if (!cfg?.manualSetup) {
    return null;
  }
  const seat = cfg.seat;
  if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat > 9) {
    return null;
  }
  return {
    seat,
    newWallet: cfg.newWallet === true,
    startHand: cfg.startHand === true,
    autoPlay: cfg.autoPlay === true,
  };
}

/** Bundled desktop native apps pass seat/setup via ZK_LAUNCH_* env (app.launchConfig bridge). */
export async function readNativeLaunchConfigFromBridge(): Promise<NativeE2eBootstrap | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  const z = (window as Window & { zero?: { invoke?: (cmd: string, payload: unknown) => Promise<unknown> } }).zero;
  if (!z || typeof z.invoke !== 'function') {
    return null;
  }
  try {
    const raw = await Promise.race([
      z.invoke('app.launchConfig', null),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 1500);
      }),
    ]);
    agentDebugLog('H2', 'native-e2e-bootstrap.ts:readNativeLaunchConfigFromBridge', 'bridge invoke result', {
      gotRaw: raw !== null && typeof raw === 'object',
      timedOut: raw === null,
    });
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const cfg = raw as { manualSetup?: boolean; seat?: number; newWallet?: boolean; startHand?: boolean; autoPlay?: boolean };
    if (!cfg.manualSetup) {
      return null;
    }
    const seat = cfg.seat;
    if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat > 9) {
      return null;
    }
    return {
      seat,
      newWallet: cfg.newWallet === true,
      startHand: cfg.startHand === true,
      autoPlay: cfg.autoPlay === true,
    };
  } catch {
    return null;
  }
}

export async function resolveNativeE2eBootstrap(): Promise<NativeE2eBootstrap | null> {
  const fromUrl = readNativeE2eConfigFromUrl();
  agentDebugLog('H2', 'native-e2e-bootstrap.ts:resolveNativeE2eBootstrap', 'url config', {
    hasUrlConfig: fromUrl !== null,
    search: typeof window !== 'undefined' ? window.location.search : '',
    seat: fromUrl?.seat ?? null,
  });
  if (fromUrl) {
    return fromUrl;
  }
  const fromWindow = readNativeLaunchConfigFromWindow();
  agentDebugLog('H2', 'native-e2e-bootstrap.ts:resolveNativeE2eBootstrap', 'window config', {
    hasWindowConfig: fromWindow !== null,
    seat: fromWindow?.seat ?? null,
    rawManual: (window as Window & { __ZK_LAUNCH_CONFIG?: { manualSetup?: boolean } }).__ZK_LAUNCH_CONFIG?.manualSetup ?? null,
  });
  if (fromWindow) {
    return fromWindow;
  }
  return readNativeLaunchConfigFromBridge();
}

function bootstrapDoneKey(seat: number): string {
  const nonce =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('e2eNonce') ?? ''
      : '';
  return `native-e2e-bootstrap-v1-${stableInstanceId()}-${seat}-${nonce}`;
}

export async function runNativeE2eBootstrap(options: {
  connectServer: () => Promise<void>;
  waitForReady: () => Promise<void>;
  rotateWallet: () => Promise<void>;
  selectSeat: (seat: number) => void;
  sitDown: () => Promise<void>;
  addChips: () => Promise<void>;
  startHand: () => Promise<void>;
  /** Bypass UI guards — call join/addChips HTTP directly. */
  joinSeat?: (seat: number) => Promise<void>;
  depositChips?: (amount: number) => Promise<void>;
  /** Credit the personal account before sit. Sit then posts those chips. */
  fundPersonal?: (amount: number) => Promise<void>;
  isSeatedAtTarget?: () => boolean;
  config: NativeE2eBootstrap;
}): Promise<void> {
  const doneKey = bootstrapDoneKey(options.config.seat);
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(doneKey)) {
    if (options.isSeatedAtTarget?.()) {
      logTiming(`native-e2e bootstrap seat=${options.config.seat} skip (done)`);
      return;
    }
    sessionStorage.removeItem(doneKey);
  }

  if (!options.config.autoPlay) {
    logTiming(`native-e2e bootstrap seat=${options.config.seat} manual`);
    const hydrated = await hydrateE2eWalletFromMeta();
    if (!hydrated) {
      getOrCreateLocalPublicKey();
    }
    options.selectSeat(options.config.seat);
    await timeAsync(`native-e2e waitForReady seat=${options.config.seat}`, options.waitForReady);
    sessionStorage.setItem(doneKey, '1');
    return;
  }

  logTiming(`native-e2e bootstrap seat=${options.config.seat} start`);
  agentDebugLog('H3', 'native-e2e-bootstrap.ts:runNativeE2eBootstrap', 'bootstrap start', {
    seat: options.config.seat,
    autoPlay: options.config.autoPlay,
    startHand: options.config.startHand,
  });
  // Restore per-seat wallet from `.local/e2e-wallet-seatN` before join/register.
  const hydrated = await hydrateE2eWalletFromMeta();
  agentDebugLog('H3', 'native-e2e-bootstrap.ts:runNativeE2eBootstrap', 'wallet hydrate', {
    seat: options.config.seat,
    hydrated: hydrated?.slice(0, 8) ?? null,
    pk: getOrCreateLocalPublicKey().slice(0, 8),
  });
  // Seat first, then ping Zig `player`. Crypto stays in the native bridge.
  await timeAsync(`native-e2e waitForReady seat=${options.config.seat}`, options.waitForReady);
  if (options.isSeatedAtTarget?.()) {
    logTiming(`native-e2e bootstrap seat=${options.config.seat} skip (already seated)`);
    sessionStorage.setItem(doneKey, '1');
    if (options.config.seat === 0) {
      void waitForNativePlayerReady(120_000);
    }
    agentDebugLog('H3', 'native-e2e-bootstrap.ts:runNativeE2eBootstrap', 'bootstrap skip seated', {
      seat: options.config.seat,
    });
    return;
  }
  if (options.config.newWallet) {
    await timeAsync(`native-e2e rotateWallet seat=${options.config.seat}`, options.rotateWallet);
  } else {
    getOrCreateLocalPublicKey();
  }
  options.selectSeat(options.config.seat);
  if (options.fundPersonal) {
    await timeAsync(`native-e2e fundPersonal seat=${options.config.seat}`, () => options.fundPersonal!(5000));
  }
  if (options.joinSeat) {
    await timeAsync(`native-e2e joinSeat seat=${options.config.seat}`, () => options.joinSeat!(options.config.seat));
  } else {
    await timeAsync(`native-e2e sitDown seat=${options.config.seat}`, options.sitDown);
  }
  if (!options.fundPersonal) {
    if (options.depositChips) {
      await timeAsync(`native-e2e depositChips seat=${options.config.seat}`, () => options.depositChips!(5000));
    } else {
      await timeAsync(`native-e2e addChips seat=${options.config.seat}`, options.addChips);
    }
  }
  if (options.config.seat === 0) {
    void waitForNativePlayerReady(120_000).then((ready) => {
      if (!ready) {
        console.warn('[native-e2e] player bridge still pending after seat — Register will retry');
      }
    });
  }
  if (options.config.startHand && options.config.seat === 0) {
    await timeAsync('native-e2e startHand', options.startHand);
  }
  sessionStorage.setItem(doneKey, '1');
  logTiming(`native-e2e bootstrap seat=${options.config.seat} done`);
  agentDebugLog('H3', 'native-e2e-bootstrap.ts:runNativeE2eBootstrap', 'bootstrap done', {
    seat: options.config.seat,
  });
}
