/**
 * Defaults for Solana localnet + optional chain-worker tooling.
 *
 * Gameplay is event-driven via Solana RPC (:8899): clients subscribe to
 * `PlayerActionRequired` program logs. Dual native clients use Vite preview
 * same-origin `/api/game*` for LocalnetTableSession mutations — no :3850.
 * The chain worker (:3850) remains optional bootstrap / CompDefs / admin tooling.
 *
 * Browser-safe: never touch bare `process` (undefined in WebView / browsers).
 */

function envTrim(name: string): string | undefined {
  try {
    if (typeof process === 'undefined' || !process?.env) return undefined;
    const v = process.env[name];
    return typeof v === 'string' ? v.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

export const LOCALNET_RPC_URL =
  envTrim('SOLANA_RPC_URL')
  || envTrim('VITE_SOLANA_RPC')
  || 'http://127.0.0.1:8899';

export const CHAIN_WORKER_PORT = Number(envTrim('CHAIN_WORKER_PORT') ?? '3850');

/** Optional localnet helper HTTP API — not required for event-driven play. */
export const CHAIN_WORKER_URL =
  envTrim('CHAIN_WORKER_URL')
  || `http://127.0.0.1:${CHAIN_WORKER_PORT}`;

/** Poker program id (Arcium localnet genesis). */
/** Devnet and localnet share the IceColdCasino program id. */
export const CASINO_PROGRAM_ID = '4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY';

export const SOLANA_TABLE_GAME_ID = 'solana-local-table';

export const LOCALNET_NOT_READY_MESSAGE =
  'Solana localnet is not ready at http://127.0.0.1:8899 (validator + Arcium MXE). '
  + 'Start it with: bun run localnet:start';

/**
 * Soft/plaintext betting on the chain worker — UI smoke only.
 * Production Solana path requires Arcium `validate_bet_v2` (default).
 * Set `ALLOW_SOFT_BETTING=1` to re-enable in-memory bet bookkeeping.
 */
export const ALLOW_SOFT_BETTING = envTrim('ALLOW_SOFT_BETTING') === '1';

/**
 * Soft showdown Complete without Groth16 verify — UI smoke only.
 * Dual-native / production path requires an accepted showdown proof (default).
 * Set `ALLOW_SOFT_SHOWDOWN=1` to re-enable dummy-proof / host softComplete.
 */
export const ALLOW_SOFT_SHOWDOWN = envTrim('ALLOW_SOFT_SHOWDOWN') === '1';
