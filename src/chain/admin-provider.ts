/**
 * Whitelist admin and MXE authority are different keys.
 *
 * Admin: `WHITELIST_ADMIN_KEYPAIR`, or `~/.config/solana/whitelist-admin.json`.
 * That file must sign as `WHITELIST_ADMIN`. WebView may inject
 * `__ZK_LAUNCH_CONFIG.whitelistAdminSecret`.
 * MXE: `MXE_AUTHORITY_KEYPAIR`, or `~/.config/solana/id.json`.
 * CompDef upload, and the devnet test fee payer.
 */
import { AnchorProvider, web3 } from '@coral-xyz/anchor';
import { WHITELIST_ADMIN } from '../room-lifecycle';
import { isLocalCluster } from './fund-sol';
import { KeypairWallet } from './keypair-wallet';

export { WHITELIST_ADMIN };

export type AdminSecretSource = number[] | Uint8Array | string | null | undefined;

function parseSecret(raw: AdminSecretSource): Uint8Array | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) return null;
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  return null;
}

type LaunchWindow = {
  __ZK_LAUNCH_CONFIG?: { whitelistAdminSecret?: number[] | string };
};

function browserWindow(): LaunchWindow | undefined {
  const g = globalThis as { window?: LaunchWindow };
  return g.window;
}

function readLaunchConfigAdminSecret(): Uint8Array | null {
  const launch = browserWindow()?.__ZK_LAUNCH_CONFIG;
  return parseSecret(launch?.whitelistAdminSecret);
}

async function readNodeAdminSecret(): Promise<Uint8Array | null> {
  if (browserWindow() !== undefined) return null;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const idPath = process.env.WHITELIST_ADMIN_KEYPAIR
    ?? path.join(os.homedir(), '.config', 'solana', 'whitelist-admin.json');
  if (!fs.existsSync(idPath)) {
    throw new Error(
      `Whitelist admin keypair not found at ${idPath}. `
      + `Set WHITELIST_ADMIN_KEYPAIR to the key that signs as ${WHITELIST_ADMIN.toBase58()}.`,
    );
  }
  return Uint8Array.from(JSON.parse(fs.readFileSync(idPath, 'utf8')) as number[]);
}

export async function loadWhitelistAdminProvider(
  connection: web3.Connection,
  secretOverride?: AdminSecretSource,
  minLamports = web3.LAMPORTS_PER_SOL,
): Promise<AnchorProvider> {
  const secret = parseSecret(secretOverride)
    ?? readLaunchConfigAdminSecret()
    ?? await readNodeAdminSecret();
  if (!secret) {
    throw new Error(
      'Whitelist admin key unavailable. In WebView inject '
      + `__ZK_LAUNCH_CONFIG.whitelistAdminSecret for ${WHITELIST_ADMIN.toBase58()}.`,
    );
  }
  const admin = web3.Keypair.fromSecretKey(secret);
  if (!admin.publicKey.equals(WHITELIST_ADMIN)) {
    throw new Error(
      `Admin pubkey ${admin.publicKey.toBase58()} does not match `
      + `WHITELIST_ADMIN ${WHITELIST_ADMIN.toBase58()}`,
    );
  }
  const balance = await connection.getBalance(admin.publicKey);
  if (balance < minLamports) {
    // WebView/browser: never block gameplay on airdrop confirm (can hang forever
    // on localnet). Orch / ensure-room fund WHITELIST_ADMIN before clients start.
    if (browserWindow() === undefined && isLocalCluster(connection.rpcEndpoint)) {
      const sig = await connection.requestAirdrop(admin.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await Promise.race([
        connection.confirmTransaction(sig, 'confirmed'),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Admin airdrop confirm timed out (15s)')), 15_000);
        }),
      ]);
    } else if (browserWindow() === undefined) {
      throw new Error(
        `Whitelist admin ${admin.publicKey.toBase58()} has ${balance} lamports. `
        + `Fund that key before a devnet hand.`,
      );
    }
  }
  return new AnchorProvider(connection, new KeypairWallet(admin), { commitment: 'confirmed' });
}

/** Arcis MXE owner. Devnet tests pay fees with this key. Not the whitelist admin. */
export async function loadMxeAuthorityKeypair(): Promise<web3.Keypair> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const idPath = process.env.MXE_AUTHORITY_KEYPAIR
    ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
  if (!fs.existsSync(idPath)) {
    throw new Error(`MXE authority keypair not found at ${idPath}`);
  }
  const secret = JSON.parse(fs.readFileSync(idPath, 'utf8')) as number[];
  return web3.Keypair.fromSecretKey(Uint8Array.from(secret));
}

/**
 * MXE authority provider. CompDef init/upload must be signed by this key.
 */
export async function loadMxeAuthorityProvider(
  connection: web3.Connection,
): Promise<AnchorProvider> {
  if (browserWindow() !== undefined) {
    throw new Error('loadMxeAuthorityProvider requires Node (MXE_AUTHORITY_KEYPAIR)');
  }
  const authority = await loadMxeAuthorityKeypair();
  const balance = await connection.getBalance(authority.publicKey);
  if (balance < web3.LAMPORTS_PER_SOL) {
    if (!isLocalCluster(connection.rpcEndpoint)) {
      throw new Error(
        `MXE authority ${authority.publicKey.toBase58()} has ${balance} lamports on `
        + `${connection.rpcEndpoint}. Fund that key before a devnet hand.`,
      );
    }
    const sig = await connection.requestAirdrop(authority.publicKey, 5 * web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
  }
  return new AnchorProvider(connection, new KeypairWallet(authority), { commitment: 'confirmed' });
}
