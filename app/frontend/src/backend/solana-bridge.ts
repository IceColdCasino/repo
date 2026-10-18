/**
 * Solana table ops for native WebView / browser.
 *
 * Default path: in-process `executePerSeatOp` → Anchor + RPC :8899.
 * Heavy `@poker-src/chain` deps are loaded lazily so Poker/UI can mount
 * even when the Solana stack fails to import.
 *
 * Thin native bridges:
 *   - `zk.prove` — Groth16 (invoke returns proof JSON; no file poll)
 * Table identity comes from launch-config / URL (injected by orch), not
 * solana.meta disk IPC. Register / shuffle / getGame use on-chain accounts.
 * `solana.op` / Bun CLI is not used by the macOS or iOS apps.
 */

import process from 'process';

export type SolanaOpName =
  | 'health'
  | 'snapshot'
  | 'getGame'
  | 'getDefaultGame'
  | 'createGame'
  | 'join'
  | 'joinGame'
  | 'stand'
  | 'standUp'
  | 'faucet'
  | 'faucetCreditPersonal'
  | 'transferToSeat'
  | 'transferPersonalToSeat'
  | 'transferToPersonal'
  | 'transferSeatToPersonal'
  | 'ensureRoom'
  | 'start'
  | 'startHand'
  | 'register'
  | 'registerHandKey'
  | 'shuffle'
  | 'submitShuffle'
  | 'share'
  | 'submitShare'
  | 'action'
  | 'placeBet'
  | 'advance'
  | 'advanceStreet'
  | 'ackHoles'
  | 'acknowledgeHoleCards'
  | 'showdown'
  | 'submitShowdown'
  | 'showdownMaterials'
  | 'getShowdownMaterials'
  | 'revealedPartials'
  | 'fetchRevealedPartials'
  | 'reset'
  | 'resetTable'
  | 'eventLog';

export type SolanaOpRequest = {
  op: SolanaOpName | string;
  seat?: number;
  publicKey?: string;
  /** Localnet per-seat signing material (JSON number[]). */
  secretKey?: number[];
  chips?: string;
  amount?: string;
  action?: string;
  proof?: object;
  publicSignals?: string[];
  ciphertexts?: string[][][];
  showOnFold?: boolean;
  smallBlind?: string;
  recipientIndex?: number;
  cardIndices?: number[];
  contents?: string;
  /** When true with ensureRoom — create a new table (E2E seat-occupied recovery). */
  forceFresh?: boolean;
  rpcUrl?: string;
};

type LaunchTableMeta = {
  roomSeed: string;
  tableId: string;
  roomIdHex?: string;
};

let metaInstalled = false;

export function resetSolanaBridgeMetaForTest(): void {
  metaInstalled = false;
}

/** Read table identity from launch-config / URL — no solana.meta disk round-trip. */
export function resolveLaunchTableMeta(): LaunchTableMeta | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const launch = (window as Window & {
    __ZK_LAUNCH_CONFIG?: {
      roomSeed?: string;
      tableId?: string | number;
      roomIdHex?: string;
    };
  }).__ZK_LAUNCH_CONFIG;
  if (launch?.roomSeed && launch.tableId !== undefined && launch.tableId !== null && `${launch.tableId}` !== '') {
    return {
      roomSeed: launch.roomSeed,
      tableId: String(launch.tableId),
      roomIdHex: typeof launch.roomIdHex === 'string' ? launch.roomIdHex : undefined,
    };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const roomSeed = params.get('roomSeed');
    const tableId = params.get('tableId');
    if (roomSeed && tableId) {
      return {
        roomSeed,
        tableId,
        roomIdHex: params.get('roomIdHex') ?? undefined,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Seed shared-table for PerSeatClient.create.
 * Prefer `.local/shared-table.json` via solana.meta when the host has advanced
 * tableId (e.g. after startHand) so both WebViews paint the same seated players.
 * Fall back to launch-config / URL when disk meta is absent.
 */
async function ensureMetaStore(): Promise<void> {
  const { writeSharedMeta, readSharedMeta, getSharedMetaStore } = await import(
    '@poker-src/chain/shared-meta-store'
  );
  if (!metaInstalled) {
    try {
      const { installWebViewMetaStore, refreshWebViewMetaCache } = await import(
        './solana-meta-bridge'
      );
      installWebViewMetaStore();
      await refreshWebViewMetaCache(['shared-table']);
    } catch {
      // plain browser / no bridge — memory store below
    }
    metaInstalled = true;
  }
  const diskRaw = readSharedMeta('shared-table');
  let diskOk = false;
  if (diskRaw) {
    try {
      const disk = JSON.parse(diskRaw) as { roomSeed?: string; tableId?: string };
      diskOk = Boolean(disk.roomSeed && disk.tableId !== undefined && `${disk.tableId}` !== '');
    } catch {
      diskOk = false;
    }
  }
  const launch = resolveLaunchTableMeta();
  if (!diskOk && launch) {
    writeSharedMeta(
      'shared-table',
      JSON.stringify(
        {
          roomSeed: launch.roomSeed,
          tableId: launch.tableId,
          ...(launch.roomIdHex ? { roomIdHex: launch.roomIdHex } : {}),
        },
        null,
        2,
      ),
    );
  } else if (diskOk && launch) {
    try {
      const disk = JSON.parse(diskRaw!) as { tableId?: string };
      if (String(disk.tableId) !== String(launch.tableId)) {
        console.info(
          `[solana-bridge] using disk shared-table tableId=${disk.tableId} `
          + `(launch-config had ${launch.tableId})`,
        );
      }
    } catch {
      // ignore
    }
  }
  // Keep store installed even if only launch seeded.
  void getSharedMetaStore();
  metaInstalled = true;
}

export function hasSolanaOpBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.zero?.invoke === 'function';
}

/** Always false — the apps never spawn Bun for Solana ops. */
export function preferSolanaCliOps(): boolean {
  return false;
}

/**
 * Run a per-seat Solana op in-process (WebView JS → RPC).
 * getGame refreshes shared-table from disk so both seats track host tableId.
 */
async function applyLaunchChainEnv(): Promise<string> {
  const { DEVNET_CLUSTER_OFFSET, resolveSolanaRpcUrl, storedChainBackend } = await import('./client');
  const rpc = resolveSolanaRpcUrl();
  const kind = storedChainBackend();
  const launch = (typeof window !== 'undefined'
    ? (window as Window & { __ZK_LAUNCH_CONFIG?: { clusterOffset?: number } }).__ZK_LAUNCH_CONFIG
    : undefined);
  const loopback = rpc.includes('127.0.0.1') || rpc.includes('localhost');
  const launchOffset = launch?.clusterOffset != null ? Number(launch.clusterOffset) : null;
  const offset = launchOffset != null && launchOffset !== 0
    ? launchOffset
    : kind === 'devnet'
      ? DEVNET_CLUSTER_OFFSET
      : kind === 'solana'
        ? 0
        : launchOffset ?? (loopback ? 0 : DEVNET_CLUSTER_OFFSET);
  process.env.SOLANA_RPC_URL = rpc;
  process.env.ARCIUM_CLUSTER_OFFSET = String(offset);
  const globalEnv = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
  if (globalEnv) globalEnv.ARCIUM_CLUSTER_OFFSET = String(offset);
  return rpc;
}

export async function invokeSolanaOp<T = unknown>(req: SolanaOpRequest): Promise<T> {
  try {
    const rpcUrl = await applyLaunchChainEnv();
    await ensureMetaStore();
    if (
      req.op === 'getGame'
      || req.op === 'getDefaultGame'
      || req.op === 'snapshot'
    ) {
      try {
        const { refreshWebViewMetaCache } = await import('./solana-meta-bridge');
        await refreshWebViewMetaCache(['shared-table', 'shared-hand']);
      } catch {
        // non-native / no disk meta
      }
    }

    const { executePerSeatOp } = await import('@poker-src/chain/per-seat-ops');
    const opReq = { ...req, rpcUrl: req.rpcUrl ?? rpcUrl };
    const opTimeoutMs =
      req.op === 'health' ? 8_000
      : req.op === 'getGame' || req.op === 'getDefaultGame' || req.op === 'snapshot' ? 20_000
      : req.op === 'join' || req.op === 'joinGame' || req.op === 'faucet'
        || req.op === 'faucetCreditPersonal' || req.op === 'transferToSeat'
        || req.op === 'transferPersonalToSeat' ? 45_000
      : req.op === 'register' || req.op === 'registerHandKey' ? 60_000
      // Share + showdown (verify + Arcis compute_pots up to 180s) need a long budget.
      : req.op === 'share' || req.op === 'submitShare' ? 0
      : req.op === 'showdown' || req.op === 'submitShowdown'
        || req.op === 'showdownMaterials' || req.op === 'getShowdownMaterials' ? 600_000
      : 120_000;
    if (opTimeoutMs === 0) {
      return await executePerSeatOp(opReq) as T;
    }
    const result = await Promise.race([
      executePerSeatOp(opReq),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`solana op ${req.op} timed out (${opTimeoutMs / 1000}s)`)),
          opTimeoutMs,
        );
      }),
    ]);
    return result as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[solana-bridge] op=${req.op} failed:`, message);
    throw new Error(message);
  }
}
