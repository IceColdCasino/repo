import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveArciumCli } from './arcium-cli';

const CASINO_DIR = path.join(process.cwd(), 'rust/casino');
const BUILD_DIR = path.join(CASINO_DIR, 'build');
const CASINO_SO = path.join(CASINO_DIR, 'target/deploy/casino.so');
const CASINO_IDL = path.join(CASINO_DIR, 'target/idl/casino.json');
const CASINO_TESTING_STAMP = path.join(CASINO_DIR, 'target/deploy/.casino_features_testing');
const CASINO_MODE_METADATA = path.join(CASINO_DIR, 'target/deploy/casino-artifact-mode.json');
/** Bump when receipt consume semantics or CPI account layout changes (forces rebuild). */
const CASINO_CPI_BRIDGE_STAMP = path.join(CASINO_DIR, 'target/deploy/.casino_cpi_bridge_v7');
const REQUIRED_ARCIS = [
  'verify_deck_hash_chunk',
  'reveal_card',
  'validate_bet',
  'seal_showdown_pair',
  'compute_pots_v4',
  'distribute_and_settle_v3',
  'settle_casino_hand',
].map((name) => path.join(BUILD_DIR, `${name}.arcis`));
const ENCRYPTED_IXS_DIR = path.join(CASINO_DIR, 'encrypted-ixs');

/** True when required Arcis artifacts exist and are newer than circuit source. */
export function casinoCircuitsBuilt(): boolean {
  if (!REQUIRED_ARCIS.every((artifact) => fs.existsSync(artifact))) return false;
  const sourceMtime = newestRustSourceMtimeMs(ENCRYPTED_IXS_DIR);
  return REQUIRED_ARCIS.every((artifact) => fs.statSync(artifact).mtimeMs >= sourceMtime);
}

export function casinoProgramBuilt(): boolean {
  return fs.existsSync(CASINO_SO);
}

export function casinoIdlBuilt(): boolean {
  return fs.existsSync(CASINO_IDL);
}

/** Circuits + casino.so required before `arcium localnet --skip-build`. */
export function casinoLocalnetArtifactsReady(): boolean {
  return casinoCircuitsBuilt() && casinoProgramBuilt();
}

/** Full artifact set for E2E (includes IDL for TypeScript clients). */
export function casinoE2EArtifactsReady(): boolean {
  return casinoLocalnetArtifactsReady() && casinoIdlBuilt();
}

/**
 * Build Arcis circuits only when missing.
 * Never re-runs arcium build if .arcis files exist — arcium build runs Clean first.
 */
export function buildArcisCircuits(options: { force?: boolean } = {}): void {
  if (!options.force && casinoCircuitsBuilt()) {
    return;
  }
  execSync(`${resolveArciumCli()} build --skip-program --skip-keys-sync`, {
    cwd: CASINO_DIR,
    stdio: 'inherit',
    env: { ...process.env, DOCKER_DEFAULT_PLATFORM: 'linux/amd64' },
  });
  if (!casinoCircuitsBuilt()) {
    throw new Error(
      `Circuit build finished but expected artifacts missing under ${BUILD_DIR}`,
    );
  }
}

function newestRustSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestRustSourceMtimeMs(full));
    } else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml' || entry.name === 'Cargo.lock') {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

function casinoProgramIsFresh(): boolean {
  if (!casinoProgramBuilt()) return false;
  const sourceMtime = Math.max(
    newestRustSourceMtimeMs(path.join(CASINO_DIR, 'programs/casino')),
    newestRustSourceMtimeMs(path.join(process.cwd(), 'rust/shared-zk-ids')),
    fs.statSync(path.join(CASINO_DIR, 'Cargo.toml')).mtimeMs,
    fs.statSync(path.join(CASINO_DIR, 'Cargo.lock')).mtimeMs,
  );
  return fs.statSync(CASINO_SO).mtimeMs >= sourceMtime;
}

function casinoNeedsTestingRebuild(testing: boolean): boolean {
  if (testing) {
    return !fs.existsSync(CASINO_TESTING_STAMP)
      || !fs.existsSync(CASINO_CPI_BRIDGE_STAMP)
      || casinoArtifactMode() !== 'testing';
  }
  return fs.existsSync(CASINO_TESTING_STAMP) || casinoArtifactMode() !== 'release';
}

function writePokerStamps(testing: boolean): void {
  fs.mkdirSync(path.dirname(CASINO_TESTING_STAMP), { recursive: true });
  if (testing) {
    fs.writeFileSync(CASINO_TESTING_STAMP, 'testing\n');
    fs.writeFileSync(CASINO_CPI_BRIDGE_STAMP, 'showdown-output-latch\n');
  } else {
    for (const stamp of [CASINO_TESTING_STAMP, CASINO_CPI_BRIDGE_STAMP]) {
      if (fs.existsSync(stamp)) fs.unlinkSync(stamp);
    }
  }
}

function casinoArtifactMode(): 'testing' | 'release' | undefined {
  if (fs.existsSync(CASINO_TESTING_STAMP)) return 'testing';
  try {
    const metadata = JSON.parse(fs.readFileSync(CASINO_MODE_METADATA, 'utf8')) as { mode?: unknown };
    return metadata.mode === 'testing' || metadata.mode === 'release' ? metadata.mode : undefined;
  } catch {
    return undefined;
  }
}

function writePokerModeMetadata(testing: boolean): void {
  fs.mkdirSync(path.dirname(CASINO_MODE_METADATA), { recursive: true });
  fs.writeFileSync(
    CASINO_MODE_METADATA,
    `${JSON.stringify({
      version: 1,
      mode: testing ? 'testing' : 'release',
      testing,
      features: testing ? ['testing'] : [],
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

/** True when local casino.so was built for CPI bridge v2 (separate payer on register consume). */
export function casinoCpiBridgeReady(): boolean {
  return fs.existsSync(CASINO_CPI_BRIDGE_STAMP) && casinoProgramBuilt();
}

/** Build the on-chain Anchor program (.so) — separate from arcium --skip-program. */
export function buildCasinoProgram(options: { testing?: boolean; force?: boolean } = {}): void {
  const testing = options.testing ?? false;
  const needsModeRebuild = casinoNeedsTestingRebuild(testing);
  if (!options.force && casinoProgramIsFresh() && !needsModeRebuild) {
    return;
  }

  const features = testing ? 'testing' : '';
  // Release builds must not enable `testing`. Localnet/E2E opts in explicitly.
  execSync('bash scripts/assert-casino-release-no-testing.sh', {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      CASINO_FEATURES: features,
      CASINO_ALLOW_TESTING: testing ? '1' : process.env.CASINO_ALLOW_TESTING ?? '',
    },
  });
  const args = [
    'build-sbf',
    '--tools-version',
    process.env.SBF_TOOLS_VERSION ?? 'v1.54',
    '--manifest-path',
    'programs/casino/Cargo.toml',
  ];
  if (features) args.push('--features', features);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUSTFLAGS: '--cfg getrandom_backend="custom"',
  };
  delete env.CARGO_TARGET_DIR;

  execSync(`cargo ${args.join(' ')}`, {
    cwd: CASINO_DIR,
    stdio: 'inherit',
    env,
  });

  if (!casinoProgramBuilt()) {
    throw new Error(`Expected program artifact at ${CASINO_SO}`);
  }
  writePokerStamps(testing);
  writePokerModeMetadata(testing);
}

/** Generate Anchor IDL (genesis-loaded poker has no on-chain IDL account). */
export function buildCasinoIdl(options: { force?: boolean } = {}): void {
  if (!options.force && casinoIdlBuilt()) {
    const idl = JSON.parse(fs.readFileSync(CASINO_IDL, 'utf8')) as {
      instructions?: Array<{ name: string; accounts?: Array<{ name: string }> }>;
    };
    const consume = idl.instructions?.find((i) => i.name === 'consume_register_receipt');
    const consumeNames = consume?.accounts?.map((a) => a.name) ?? [];
    const close = idl.instructions?.find((i) => i.name === 'close_revealed_card');
    const closeNames = close?.accounts?.map((a) => a.name) ?? [];
    const seal = idl.instructions?.find((i) => i.name === 'seal_showdown_pair');
    const sealNames = seal?.accounts?.map((a) => a.name) ?? [];
    const ok =
      consumeNames[0] === 'authority'
      && consumeNames.includes('game_state')
      && !consumeNames.includes('payer')
      && closeNames.includes('refund_to')
      && closeNames.includes('table_state')
      && sealNames.includes('table_state')
      && sealNames.includes('player_state');
    if (ok) return;
  }
  fs.mkdirSync(path.dirname(CASINO_IDL), { recursive: true });
  // Include `testing` helpers (set_showdown_hash, set_pot_amounts, …) used by E2E.
  execSync(
    'anchor idl build -p casino -o target/idl/casino.json --skip-lint -- --features testing',
    {
      cwd: CASINO_DIR,
      stdio: 'inherit',
    },
  );
  if (!casinoIdlBuilt()) {
    throw new Error(`Expected IDL at ${CASINO_IDL}`);
  }
}

/** Ensure artifacts exist for localnet; skip any step whose outputs are already present. */
export function ensureCasinoArtifactsForLocalnet(options: { testing?: boolean } = {}): void {
  buildArcisCircuits();
  buildCasinoProgram({ testing: options.testing ?? true });
  buildCasinoIdl();
  // Localnet publishes the program at the keypair address. That is a deploy.
  execSync('bash scripts/fetch-program-keypairs.sh casino', {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (!casinoLocalnetArtifactsReady()) {
    throw new Error(
      'Localnet prerequisites missing after build. Run: cd rust/casino && ./scripts/build.sh',
    );
  }
}

/** Full poker workspace build: circuits then program then IDL. */
export function buildCasinoWorkspace(options: { testing?: boolean; force?: boolean } = {}): void {
  buildArcisCircuits({ force: options.force });
  buildCasinoProgram({ testing: options.testing, force: options.force });
  buildCasinoIdl({ force: options.force });
}
