/**
 * Light Protocol URL defaults + readiness probes (browser/Node safe).
 * Localnet genesis / Photon spawn stay in `test/e2e/light-localnet.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { web3 } from '@coral-xyz/anchor';

export const LIGHT_RPC_URL_DEFAULT = 'http://127.0.0.1:8899';
export const LIGHT_INDEXER_URL_DEFAULT = 'http://127.0.0.1:8784';
export const LIGHT_PROVER_URL_DEFAULT = 'http://127.0.0.1:3001';

/** Resolved at call time so LIGHT_*_URL env overrides work after import. */
export function lightRpcUrl(): string {
  return process.env.LIGHT_RPC_URL ?? LIGHT_RPC_URL_DEFAULT;
}
export function lightIndexerUrl(): string {
  return process.env.LIGHT_INDEXER_URL ?? LIGHT_INDEXER_URL_DEFAULT;
}
export function lightProverUrl(): string {
  return process.env.LIGHT_PROVER_URL ?? LIGHT_PROVER_URL_DEFAULT;
}

/** @deprecated Prefer lightRpcUrl() — kept for existing imports. */
export const LIGHT_RPC_URL = process.env.LIGHT_RPC_URL ?? LIGHT_RPC_URL_DEFAULT;
/** Photon indexer — CLI default `--indexer-port 8784`. */
export const LIGHT_INDEXER_URL = process.env.LIGHT_INDEXER_URL ?? LIGHT_INDEXER_URL_DEFAULT;
/** Gnark prover — CLI default `--prover-port 3001`. */
export const LIGHT_PROVER_URL = process.env.LIGHT_PROVER_URL ?? LIGHT_PROVER_URL_DEFAULT;

/** Light system program (pinocchio) — required for compressed CPI. */
export const LIGHT_SYSTEM_PROGRAM_ID = 'SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7';
export const LIGHT_ACCOUNT_COMPRESSION_ID = 'compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq';

const LIGHT_CLI_ROOT = process.env.LIGHT_CLI_ROOT
  ?? '/usr/local/lib/node_modules/@lightprotocol/zk-compression-cli';

export const LIGHT_ACCOUNTS_DIR = path.join(LIGHT_CLI_ROOT, 'accounts');
export const LIGHT_BIN_DIR = path.join(LIGHT_CLI_ROOT, 'bin');
/** Repo-local copies — preferred for Anchor.toml absolute paths. */
export const LIGHT_ARTIFACTS_BIN_DIR = path.join(
  process.cwd(),
  'rust/casino/artifacts/light',
);

/** Resolve a Light .so from artifacts/ first, then CLI bin/. */
export function resolveLightProgramSo(filename: string): string | null {
  for (const dir of [LIGHT_ARTIFACTS_BIN_DIR, LIGHT_BIN_DIR]) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Programs `light test-validator` loads via `--bpf-program`. */
export const LIGHT_SYSTEM_PROGRAMS: { id: string; so: string }[] = [
  { id: 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', so: 'spl_noop.so' },
  { id: LIGHT_SYSTEM_PROGRAM_ID, so: 'light_system_program_pinocchio.so' },
  { id: 'cTokenmWW8bLPjZEBAUgYy3zKxQZW6VKi7bqNFEVv3m', so: 'light_compressed_token.so' },
  { id: LIGHT_ACCOUNT_COMPRESSION_ID, so: 'account_compression.so' },
  { id: 'Lighton6oQpVkeewmo2mcPTQQp7kYHr4fWpAgJyEmDX', so: 'light_registry.so' },
];

export type LightStackStatus = {
  indexer: boolean;
  prover: boolean;
  systemProgram: boolean;
  /** True when indexer + on-chain Light system program are present. */
  ready: boolean;
  accountsDir: boolean;
  cliBins: boolean;
};

async function probeHttp(url: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url.replace(/\/$/, '') + '/', { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    if (res && (res.ok || res.status === 400 || res.status === 405 || res.status === 404)) {
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export async function isLightIndexerUp(
  indexerUrl: string = lightIndexerUrl(),
  timeoutMs = 1_500,
): Promise<boolean> {
  if (process.env.LIGHT_E2E === '0') return false;
  if (await probeHttp(indexerUrl, timeoutMs)) return true;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${indexerUrl.replace(/\/$/, '')}/getCompressedAccountsByOwner`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: web3.PublicKey.default.toBase58() }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok || res.status === 400 || res.status === 405;
  } catch {
    return false;
  }
}

export async function isLightProverUp(
  proverUrl: string = lightProverUrl(),
  timeoutMs = 1_500,
): Promise<boolean> {
  return probeHttp(proverUrl, timeoutMs);
}

export async function isLightSystemProgramOnChain(
  rpcUrl: string = lightRpcUrl(),
): Promise<boolean> {
  try {
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const info = await connection.getAccountInfo(new web3.PublicKey(LIGHT_SYSTEM_PROGRAM_ID));
    return info !== null && info.executable;
  } catch {
    return false;
  }
}

export async function lightStackStatus(): Promise<LightStackStatus> {
  const [indexer, prover, systemProgram] = await Promise.all([
    isLightIndexerUp(),
    isLightProverUp(),
    isLightSystemProgramOnChain(),
  ]);
  const accountsDir = fs.existsSync(LIGHT_ACCOUNTS_DIR);
  const binsOk = LIGHT_SYSTEM_PROGRAMS.every((p) => resolveLightProgramSo(p.so) !== null)
    || (
      resolveLightProgramSo('light_system_program_pinocchio.so') !== null
      && resolveLightProgramSo('account_compression.so') !== null
      && resolveLightProgramSo('spl_noop.so') !== null
    );

  return {
    indexer,
    prover,
    systemProgram,
    ready: indexer && prover && systemProgram,
    accountsDir,
    cliBins: binsOk,
  };
}
