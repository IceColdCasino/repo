import type { BackendKind } from './client';
import { createPokerClient, type PokerClient } from './client';

const STORAGE_KEY = 'poker-backend';

export function loadBackendKind(): BackendKind {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'solana' || stored === 'devnet') return stored;
  return 'local';
}

export function saveBackendKind(kind: BackendKind): void {
  localStorage.setItem(STORAGE_KEY, kind);
}

/**
 * Prefer URL / launch-config override (E2E), then persisted localStorage.
 * Supports `?backend=solana` and `__ZK_LAUNCH_CONFIG.backend`.
 */
export function resolveBackendKind(): BackendKind {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const query = params.get('backend');
    if (query === 'solana' || query === 'local' || query === 'devnet') {
      return query;
    }
    const launch = (window as Window & {
      __ZK_LAUNCH_CONFIG?: { backend?: string; clusterOffset?: number; solanaRpc?: string };
    }).__ZK_LAUNCH_CONFIG;
    if (launch?.backend === 'devnet') {
      return 'devnet';
    }
    if (launch?.backend === 'solana') {
      const rpc = launch.solanaRpc ?? '';
      const remote = rpc.length > 0 && !rpc.includes('127.0.0.1') && !rpc.includes('localhost');
      if (launch.clusterOffset === 456 || remote) return 'devnet';
      return 'solana';
    }
    if (launch?.backend === 'local') {
      return 'local';
    }
  }
  return loadBackendKind();
}

export function createClient(kind: BackendKind): PokerClient {
  return createPokerClient(kind);
}

export type { BackendKind, BetAction, GameSnapshot, PokerClient, ZkHandSnapshot, ChainWorkerHealth } from './client';
export {
  LOCAL_TABLE_GAME_ID,
  SOLANA_TABLE_GAME_ID,
  SolanaPokerClient,
  HttpPokerClient,
  DEFAULT_CHAIN_WORKER_URL,
  DEFAULT_SOLANA_RPC_URL,
  resolveOptionalChainWorkerBase,
  resolveSolanaTableApiBase,
  resolveSolanaRpcUrl,
  resolveChainWorkerBase,
  ActionKind,
  isChainPhaseForward,
  mergeWorkerIntoChainSnapshot,
  phaseFromChainAdvanced,
  SOLANA_PHASE_RANK,
} from './client';
