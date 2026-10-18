/**
 * Localnet readiness — RPC probe (browser-safe).
 * Node CLI may additionally check `solana` / `arcium` CLIs via test/e2e/localnet-health.
 */
import { web3 } from '@coral-xyz/anchor';
import {
  LOCALNET_NOT_READY_MESSAGE,
  LOCALNET_RPC_URL,
} from './localnet-config';

/** True when Solana RPC answers getVersion (validator up). */
export async function isRpcReady(rpcUrl = LOCALNET_RPC_URL): Promise<boolean> {
  try {
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    await connection.getVersion();
    return true;
  } catch {
    return false;
  }
}

export async function assertRpcReady(rpcUrl = LOCALNET_RPC_URL): Promise<void> {
  if (!(await isRpcReady(rpcUrl))) {
    throw new Error(LOCALNET_NOT_READY_MESSAGE);
  }
}
