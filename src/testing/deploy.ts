import { web3, AnchorProvider, Program } from '@coral-xyz/anchor';
import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCasinoProgram,
  buildCasinoIdl,
  ensureCasinoArtifactsForLocalnet,
} from './build-casino';
import { createHash } from 'node:crypto';

export const CASINO_PROGRAM_ID = '4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY';
export const LIGHT_CASINO_PROGRAM_ID = 'CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc';

const CASINO_DIR = path.join(process.cwd(), 'rust/casino');
const IDL_PATH = path.join(CASINO_DIR, 'target/idl/casino.json');
const BUNDLED_IDL_PATH = path.join(process.cwd(), 'src/chain/idl/casino.json');
const TYPES_PATH = path.join(CASINO_DIR, 'target/types/casino.ts');

function idlPda(programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('anchor:idl'), programId.toBuffer()],
    programId,
  )[0];
}

async function idlAccountExists(connection: web3.Connection): Promise<boolean> {
  const programId = new web3.PublicKey(CASINO_PROGRAM_ID);
  const account = await connection.getAccountInfo(idlPda(programId));
  return account !== null && account.data.length > 0;
}

function syncCasinoIdlTypes(): void {
  if (!fs.existsSync(IDL_PATH)) return;
  if (fs.existsSync(TYPES_PATH)) return;
  fs.mkdirSync(path.dirname(TYPES_PATH), { recursive: true });
  execSync(`anchor idl type -o target/types/casino.ts target/idl/casino.json`, {
    cwd: CASINO_DIR,
    stdio: 'inherit',
  });
}

/** Fetch on-chain IDL after anchor deploy (not available for genesis-loaded poker). */
export function fetchCasinoIdl(connection: web3.Connection): void {
  fs.mkdirSync(path.dirname(IDL_PATH), { recursive: true });
  execSync(
    `anchor idl fetch -o target/idl/casino.json ${CASINO_PROGRAM_ID}`,
    {
      cwd: CASINO_DIR,
      stdio: 'inherit',
      env: { ...process.env, ANCHOR_PROVIDER_URL: connection.rpcEndpoint },
    },
  );
  syncCasinoIdlTypes();
}

/** Use cached/generated IDL or fetch from chain when the IDL account exists. */
export async function ensureCasinoIdl(_connection: web3.Connection): Promise<void> {
  if (fs.existsSync(IDL_PATH)) {
    syncCasinoIdlTypes();
    return;
  }
  if (await idlAccountExists(_connection)) {
    fetchCasinoIdl(_connection);
    return;
  }
  buildCasinoIdl();
  syncCasinoIdlTypes();
}

function ensureCasinoIdlOnDisk(connection?: web3.Connection): void {
  if (fs.existsSync(IDL_PATH)) return;
  if (!connection) {
    throw new Error(
      `Missing ${IDL_PATH}. Start localnet first or run: cd rust/casino && ./scripts/build.sh`,
    );
  }
  throw new Error(
    `Missing ${IDL_PATH}. Call ensureCasinoIdl(connection) after localnet is online.`,
  );
}

/** Load poker program from the source-controlled contract used by clients. */
export function loadCasinoProgram(provider: AnchorProvider): Program {
  const idlPath = fs.existsSync(BUNDLED_IDL_PATH) ? BUNDLED_IDL_PATH : IDL_PATH;
  ensureCasinoIdlOnDisk(provider.connection);
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  idl.address = CASINO_PROGRAM_ID;
  return new Program(idl, provider);
}

/** Build + deploy poker (for tests that start their own validator). */
export async function deployCasinoProgram(provider: AnchorProvider): Promise<Program> {
  buildCasinoProgram({ testing: true });
  execSync('bash scripts/fetch-program-keypairs.sh casino', {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  execSync('anchor deploy --program-name casino', {
    cwd: CASINO_DIR,
    stdio: 'inherit',
    env: { ...process.env, ANCHOR_PROVIDER_URL: provider.connection.rpcEndpoint },
  });
  fetchCasinoIdl(provider.connection);
  return loadCasinoProgram(provider);
}

/**
 * True when on-chain poker embeds light-casino CPI (proof_receipt / program id).
 * Pre-bridge genesis binaries lack these and cannot consume receipts.
 */
export async function onChainCasinoSupportsCpi(connection: web3.Connection): Promise<boolean> {
  const dumpPath = path.join(CASINO_DIR, 'target/deploy/.casino-onchain-dump.so');
  try {
    execSync(
      `solana program dump ${CASINO_PROGRAM_ID} ${dumpPath} --url ${connection.rpcEndpoint}`,
      { stdio: 'pipe' },
    );
    const data = fs.readFileSync(dumpPath);
    return (
      data.includes(Buffer.from('CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc'))
      && data.includes(Buffer.from('proof_receipt'))
    );
  } catch {
    return false;
  }
}

/**
 * Ensure local poker IDL matches the CPI bridge layout used against genesis poker.
 * Poker is immutable on Arcium localnet — a .so hash mismatch only matters after restart.
 */
export async function ensureCasinoMatchesLocalnet(connection: web3.Connection): Promise<void> {
  ensureCasinoArtifactsForLocalnet({ testing: true });
  buildCasinoIdl();

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8')) as {
    instructions?: Array<{ name: string; accounts?: Array<{ name: string }> }>;
  };
  const ix = idl.instructions?.find((i) => i.name === 'consume_register_receipt');
  const names = ix?.accounts?.map((a) => a.name) ?? [];
  if (names.includes('payer') || names[0] !== 'authority') {
    buildCasinoIdl({ force: true });
  }

  const soPath = path.join(CASINO_DIR, 'target/deploy/casino.so');
  if (!fs.existsSync(soPath)) return;

  const localHash = createHash('sha256').update(fs.readFileSync(soPath)).digest('hex');
  const dumpPath = path.join(CASINO_DIR, 'target/deploy/.casino-onchain-dump.so');
  try {
    execSync(
      `solana program dump ${CASINO_PROGRAM_ID} ${dumpPath} --url ${connection.rpcEndpoint}`,
      { stdio: 'pipe' },
    );
    const onchainHash = createHash('sha256').update(fs.readFileSync(dumpPath)).digest('hex');
    if (localHash !== onchainHash) {
      throw new Error(
        '[e2e] casino.so differs from on-chain genesis binary. '
          + 'Run bun run localnet:restart before E2E. '
          + `local=${localHash.slice(0, 12)}… on-chain=${onchainHash.slice(0, 12)}…`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('casino.so differs')) {
      throw error;
    }
    throw new Error(
      `Unable to verify on-chain poker binary freshness: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Ensure circuits + program exist; does not rebuild when artifacts are present. */
export function buildCasinoForLocalnet(): void {
  ensureCasinoArtifactsForLocalnet({ testing: true });
}

const LIGHT_CASINO_DIR = path.join(process.cwd(), 'rust/light-casino');
const LIGHT_CASINO_SO = path.join(LIGHT_CASINO_DIR, 'target/deploy/light_casino.so');
/** Pinocchio light-casino IDL, generated by `pinocchio-idl` (`idl/generate.py`). */
const LIGHT_CASINO_IDL = path.join(LIGHT_CASINO_DIR, 'idl/light_casino.json');
const LIGHT_CASINO_TESTING_STAMP = path.join(
  LIGHT_CASINO_DIR,
  'target/deploy/.light_casino_features_testing',
);

function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (
      entry.name.endsWith('.rs')
      || entry.name === 'Cargo.toml'
      || entry.name === 'Cargo.lock'
    ) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

export function lightCasinoProgramBuilt(): boolean {
  if (!fs.existsSync(LIGHT_CASINO_SO)) return false;
  const sourceMtime = Math.max(
    newestSourceMtimeMs(path.join(LIGHT_CASINO_DIR, 'programs/light-casino')),
    newestSourceMtimeMs(path.join(process.cwd(), 'rust/shared-zk-ids')),
    fs.statSync(path.join(LIGHT_CASINO_DIR, 'Cargo.toml')).mtimeMs,
    fs.statSync(path.join(LIGHT_CASINO_DIR, 'Cargo.lock')).mtimeMs,
  );
  return fs.statSync(LIGHT_CASINO_SO).mtimeMs >= sourceMtime;
}

function lightCasinoBuildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  return env;
}

export function buildLightCasinoProgram(options: { force?: boolean; testing?: boolean } = {}): void {
  const testing = options.testing ?? true;
  const needsTestingStamp = testing && !fs.existsSync(LIGHT_CASINO_TESTING_STAMP);
  if (!options.force && lightCasinoProgramBuilt() && !needsTestingStamp) return;
  const features = testing ? ' --features testing' : '';
  execSync(
    'RUSTFLAGS=\'--cfg getrandom_backend="custom"\' cargo build-sbf --tools-version v1.54 '
    + `--manifest-path programs/light-casino/Cargo.toml${features}`,
    {
      cwd: LIGHT_CASINO_DIR,
      stdio: 'inherit',
      shell: '/bin/bash',
      env: lightCasinoBuildEnv(),
    },
  );
  if (!lightCasinoProgramBuilt()) {
    throw new Error(`Expected ${LIGHT_CASINO_SO} after build`);
  }
  if (testing) {
    fs.mkdirSync(path.dirname(LIGHT_CASINO_TESTING_STAMP), { recursive: true });
    fs.writeFileSync(LIGHT_CASINO_TESTING_STAMP, 'testing\n');
  } else if (fs.existsSync(LIGHT_CASINO_TESTING_STAMP)) {
    fs.unlinkSync(LIGHT_CASINO_TESTING_STAMP);
  }
}

/** Program id must match `ID` in the pinocchio binary. The keypair comes from 1Password. */
function installLightCasinoKeypair(): void {
  execSync('bash scripts/fetch-program-keypairs.sh light-casino', {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

function lightCasinoProgramId(): web3.PublicKey {
  installLightCasinoKeypair();
  const expected = new web3.PublicKey(LIGHT_CASINO_PROGRAM_ID);
  const keypairPath = path.join(LIGHT_CASINO_DIR, 'target/deploy/light_casino-keypair.json');
  if (!fs.existsSync(keypairPath)) return expected;
  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8')) as number[];
  const derived = web3.Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey;
  if (!derived.equals(expected)) {
    throw new Error(
      `light-casino keypair from 1Password signs as ${derived.toBase58()}, `
      + `but the light-casino program id is ${LIGHT_CASINO_PROGRAM_ID}`,
    );
  }
  return derived;
}

async function lightCasinoDeployed(connection: web3.Connection): Promise<boolean> {
  const programId = lightCasinoProgramId();
  return lightProgramExecutable(connection, programId);
}

/**
 * Upgradeable-loader ProgramData stores the ELF after a 45-byte header
 * (tag, slot, authority option, authority). A genesis or earlier deploy can
 * leave an older binary in place while the local `.so` is already newer than
 * its sources, which makes the freshness check skip the upgrade.
 */
async function deployedLightMatchesLocal(
  connection: web3.Connection,
  programId: web3.PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(programId, 'confirmed');
  if (!info || info.data.length < 36 || info.data.readUInt32LE(0) !== 2) return false;
  const programData = new web3.PublicKey(info.data.subarray(4, 36));
  const data = await connection.getAccountInfo(programData, 'confirmed');
  if (!data || data.data.length < 45) return false;
  const elf = data.data.subarray(45);
  const local = fs.readFileSync(LIGHT_CASINO_SO);
  return elf.length === local.length && elf.equals(local);
}

/** Upgradeable-loader Program account points at a ProgramData account that holds the ELF. */
async function lightProgramExecutable(
  connection: web3.Connection,
  programId: web3.PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(programId, 'confirmed');
  if (!info?.executable || info.data.length < 36) return false;
  if (info.data.readUInt32LE(0) !== 2) return info.data.length > 1000;
  const programData = new web3.PublicKey(info.data.subarray(4, 36));
  const data = await connection.getAccountInfo(programData, 'confirmed');
  if (data === null || data.data.length <= 1000 || data.data.length < 12) return false;
  if (data.data.readUInt32LE(0) !== 3) return false;
  // UpgradeableLoaderState::ProgramData.slot. The runtime keeps a program
  // deployed in this slot at DelayVisibility ("Program is not deployed")
  // until the bank advances.
  const deploySlot = data.data.readBigUInt64LE(4);
  const slot = BigInt(await connection.getSlot('confirmed'));
  return slot > deploySlot;
}

async function waitForLightProgram(
  connection: web3.Connection,
  programId: web3.PublicKey,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (await lightProgramExecutable(connection, programId)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `light-casino ${programId.toBase58()} is not an executable program on ${connection.rpcEndpoint}`,
  );
}

export async function deployLightCasinoProgram(
  provider: AnchorProvider,
  options: { force?: boolean; upgrade?: boolean } = {},
): Promise<Program> {
  const wasFresh = lightCasinoProgramBuilt();
  const hadTestingStamp = fs.existsSync(LIGHT_CASINO_TESTING_STAMP);
  buildLightCasinoProgram({ force: options.force, testing: true });
  installLightCasinoKeypair();
  const rebuiltForTesting = !hadTestingStamp && fs.existsSync(LIGHT_CASINO_TESTING_STAMP);
  const rebuiltForSource = !wasFresh && lightCasinoProgramBuilt();
  const deployed = await lightCasinoDeployed(provider.connection);
  const matchesLocal = deployed
    && await deployedLightMatchesLocal(provider.connection, lightCasinoProgramId());
  if (!deployed) {
    execSync('anchor deploy --program-name light-casino', {
      cwd: LIGHT_CASINO_DIR,
      stdio: 'inherit',
      env: { ...process.env, ANCHOR_PROVIDER_URL: provider.connection.rpcEndpoint },
    });
  } else if (
    options.upgrade || options.force || rebuiltForTesting || rebuiltForSource || !matchesLocal
  ) {
    // Redeploy over an existing program (e.g. after regenerating verifying keys
    // or enabling the `testing` feature for Arcium-only E2E Light CPI skips).
    execSync(
      `solana program deploy ${LIGHT_CASINO_SO} `
      + `--program-id ${path.join(LIGHT_CASINO_DIR, 'target/deploy/light_casino-keypair.json')} `
      + `--url ${provider.connection.rpcEndpoint}`,
      {
        cwd: LIGHT_CASINO_DIR,
        stdio: 'inherit',
        env: lightCasinoBuildEnv(),
      },
    );
  }
  const idl = JSON.parse(fs.readFileSync(LIGHT_CASINO_IDL, 'utf8'));
  const programId = lightCasinoProgramId();
  idl.address = programId.toBase58();
  await waitForLightProgram(provider.connection, programId);
  return new Program(idl, provider);
}

/** Load the pinocchio IDL against an already-deployed light-casino. Does not build or upgrade. */
export function loadLightCasinoProgram(provider: AnchorProvider): Program {
  const idl = JSON.parse(fs.readFileSync(LIGHT_CASINO_IDL, 'utf8'));
  idl.address = LIGHT_CASINO_PROGRAM_ID;
  return new Program(idl, provider);
}
