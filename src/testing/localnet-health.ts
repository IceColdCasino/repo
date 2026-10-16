import { spawnSync } from 'child_process';
import { resolveArciumCli } from './arcium-cli';
import { CASINO_PROGRAM_ID } from './deploy';

export const LOCALNET_RPC = 'http://localhost:8899';

export function isValidatorReady(): boolean {
  try {
    return spawnSync('solana', ['cluster-version', '-u', 'localhost'], {
      stdio: 'pipe',
    }).status === 0;
  } catch {
    return false;
  }
}

export function isArciumMxeReady(): boolean {
  try {
    const result = spawnSync(
      resolveArciumCli(),
      ['mxe-info', CASINO_PROGRAM_ID, '-u', 'localnet'],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    if (result.status !== 0) return false;
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const line = text.split('\n').find((row) => /x25519/i.test(row));
    // mxe-info succeeds as soon as the account exists. Computations fail with
    // MxeKeysNotSet until cluster keygen writes a real X25519 pubkey.
    if (!line) return false;
    if (/not set/i.test(line)) return false;
    if (/\[\s*0(?:\s*,\s*0)+\s*\]/.test(line)) return false;
    if (/11111111111111111111111111111111/.test(line)) return false;
    if (/pubkey:\s*$/i.test(line.trim())) return false;
    return true;
  } catch {
    return false;
  }
}

export function isLocalnetReady(): boolean {
  return isValidatorReady() && isArciumMxeReady();
}
