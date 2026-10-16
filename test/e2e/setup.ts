import { web3, AnchorProvider } from '@coral-xyz/anchor';
import { requirePlayerFfi } from '../../src/player-ffi';
import { default as Wallet } from '@coral-xyz/anchor/dist/esm/nodewallet';
import { ArciumLocalnet, LOCALNET_RPC } from './arcium-localnet';
import { loadMxeAuthorityKeypair } from '../../src/chain/admin-provider';
import type { LocalnetOrchestrator } from './localnet-orchestrator';
import {
  CASINO_PROGRAM_ID,
  LIGHT_CASINO_PROGRAM_ID,
  loadCasinoProgram,
  loadLightCasinoProgram,
  deployLightCasinoProgram,
  ensureCasinoIdl,
  ensureCasinoMatchesLocalnet,
  onChainCasinoSupportsCpi,
} from './deploy';
import { isLocalCluster } from '../../src/chain/fund-sol';

const DEVNET_RPC = 'https://api.devnet.solana.com';

export type E2ECluster = 'localnet' | 'devnet';

export function e2eCluster(): E2ECluster {
  const raw = process.env.E2E_CLUSTER ?? 'localnet';
  if (raw === 'localnet' || raw === 'devnet') return raw;
  throw new Error(`E2E_CLUSTER must be localnet or devnet, got ${raw}`);
}

// Fill-mask shuffle staging: fan out write txs (see onchain-game-lifecycle).
process.env.SHUFFLE_WRITE_CONCURRENCY ??= '16';

export interface E2EContext {
  provider: AnchorProvider;
  pokerProgram: any;
  lightPokerProgram: any;
  payer: web3.Keypair;
  /** Present on localnet. Devnet does not start an orchestrator. */
  orchestrator?: LocalnetOrchestrator;
  /** False when genesis poker predates the light-casino CPI bridge. */
  pokerCpiSupported: boolean;
}

export interface LocalnetContext {
  connection: web3.Connection;
  orchestrator: LocalnetOrchestrator;
}

/** Start arcium localnet only — no IDL fetch or light-casino deploy. */
export async function setupLocalnet(): Promise<LocalnetContext> {
  const orchestrator = await ArciumLocalnet.acquire();
  return {
    connection: new web3.Connection(LOCALNET_RPC),
    orchestrator,
  };
}

export async function setupE2E(): Promise<E2EContext> {
  // Player math (keys, shuffle, share, hashes) is libzkcasino FFI.
  // Player Groth16 (register/shuffle/share/showdown) is the Zig player bridge.
  // The Arcis server for these hands is always Solana + Arcium — not the local TS backend.
  requirePlayerFfi();
  const { requirePlayerBridge } = await import('../../src/player-bridge-ffi');
  requirePlayerBridge();
  if (e2eCluster() === 'devnet') return setupDevnetE2E();
  return setupLocalnetE2E();
}

async function setupLocalnetE2E(): Promise<E2EContext> {
  const { connection, orchestrator } = await setupLocalnet();
  // Pin confirmed commitment so account fetches after .rpc() see the same state.
  const confirmedConnection = new web3.Connection(connection.rpcEndpoint, 'confirmed');

  const payer = web3.Keypair.generate();
  const provider = new AnchorProvider(
    confirmedConnection,
    new Wallet(payer),
    { commitment: 'confirmed' },
  );

  const airdropSig = await confirmedConnection.requestAirdrop(
    payer.publicKey,
    25 * web3.LAMPORTS_PER_SOL,
  );
  await confirmedConnection.confirmTransaction(airdropSig, 'confirmed');

  await ensureCasinoIdl(connection);
  await ensureCasinoMatchesLocalnet(confirmedConnection);
  const pokerCpiSupported = await onChainCasinoSupportsCpi(confirmedConnection);
  if (!pokerCpiSupported) {
    console.warn(
      '[e2e] On-chain poker lacks light-casino CPI bridge — dual-program register/shuffle '
        + 'will use light-only verify + poker init_player_state. Restart localnet after '
        + 'rebuilding casino.so to enable CPI consume.',
    );
  }
  const pokerProgram = loadCasinoProgram(provider);
  // Fresh localnet has no per-circuit CompDef accounts (Arcium 0.14 does not
  // genesis them). Upload once; later hands see them finalized and skip.
  if (process.env.UPLOAD_COMP_DEFS == null && process.env.SKIP_COMP_DEFS !== '1') {
    process.env.UPLOAD_COMP_DEFS = '1';
  }
  const lightPokerProgram = await deployLightCasinoProgram(provider);

  return { provider, pokerProgram, lightPokerProgram, payer, orchestrator, pokerCpiSupported };
}

function devnetRpc(): string {
  const rpc = process.env.SOLANA_RPC_URL ?? DEVNET_RPC;
  if (isLocalCluster(rpc)) {
    throw new Error(`E2E_CLUSTER=devnet cannot use local RPC ${rpc}`);
  }
  return rpc;
}

async function requireExecutable(
  connection: web3.Connection,
  programId: string,
  name: string,
): Promise<void> {
  const info = await connection.getAccountInfo(new web3.PublicKey(programId));
  if (!info?.executable) {
    throw new Error(
      `${name} ${programId} is not an executable program on ${connection.rpcEndpoint}`,
    );
  }
}

/**
 * Same hands as localnet, against the vanity programs already on devnet.
 * Does not start localnet and does not upgrade light-casino.
 * Set `E2E_UPGRADE=1` only when this key may upgrade the program.
 * The fee payer is the MXE authority. A short key gets one faucet attempt.
 */
async function setupDevnetE2E(): Promise<E2EContext> {
  const offset = process.env.ARCIUM_CLUSTER_OFFSET;
  if (offset == null || offset === '') {
    throw new Error(
      'Set ARCIUM_CLUSTER_OFFSET to the devnet MXE offset before bun run test:e2e:devnet',
    );
  }
  const connection = new web3.Connection(devnetRpc(), 'confirmed');
  const payer = await loadMxeAuthorityKeypair();
  let balance = await connection.getBalance(payer.publicKey);
  if (balance < 2 * web3.LAMPORTS_PER_SOL) {
    try {
      const sig = await connection.requestAirdrop(payer.publicKey, 2 * web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[e2e] devnet airdrop failed (${msg.split('\n')[0]})`);
    }
    balance = await connection.getBalance(payer.publicKey);
  }
  if (balance < 2 * web3.LAMPORTS_PER_SOL) {
    throw new Error(
      `MXE authority ${payer.publicKey.toBase58()} has ${balance} lamports. `
      + 'Fund that key before bun run test:e2e:devnet:keno.',
    );
  }
  const rpcLog = connection.rpcEndpoint.split('?')[0];
  console.log(
    `[e2e] cluster=devnet rpc=${rpcLog} `
    + `mxe=${payer.publicKey.toBase58()} offset=${offset}`,
  );

  await requireExecutable(connection, CASINO_PROGRAM_ID, 'casino');
  await requireExecutable(connection, LIGHT_CASINO_PROGRAM_ID, 'light-casino');
  await ensureCasinoIdl(connection);
  const pokerCpiSupported = await onChainCasinoSupportsCpi(connection);
  if (!pokerCpiSupported) {
    throw new Error(
      `[e2e] casino on ${connection.rpcEndpoint} does not embed the light-casino CPI bridge`,
    );
  }
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });
  const pokerProgram = loadCasinoProgram(provider);
  const lightPokerProgram = process.env.E2E_UPGRADE === '1'
    ? await deployLightCasinoProgram(provider, { upgrade: true })
    : loadLightCasinoProgram(provider);
  return { provider, pokerProgram, lightPokerProgram, payer, pokerCpiSupported };
}

export async function teardownE2E(ctx?: E2EContext | LocalnetContext): Promise<void> {
  if (ctx?.orchestrator) {
    await ArciumLocalnet.release();
  }
}

/** Bun beforeAll timeout for setupE2E (arcium genesis is large). */
export const E2E_SETUP_TIMEOUT_MS = 1_800_000;

/** Re-export — implementation lives in `src/chain/admin-provider.ts`. */
export { loadMxeAuthorityProvider, loadWhitelistAdminProvider } from '../../src/chain/admin-provider';
