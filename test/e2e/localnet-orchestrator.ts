import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPLE_CONTAINER_NOT_RUNNING_MESSAGE,
  arciumDockerEnv,
  arciumDockerPullError,
  ensureArxNodeConfigs,
  padMxeAccountRecoveryFields,
  patchArciumDockerArtifacts,
  patchMxeHandCompDefOffsets,
  pinArciumTomlNodeIps,
  retargetMxeKeygenToCasinoProgram,
  resetAppleArxDhcpNetwork,
  resolveArxNodeIps,
  resolveDockerBinary,
  resolveTrustedDealerIpArg,
} from './arcium-docker';
import { resolveArciumCli } from '../../src/testing/arcium-cli';
import { buildCasinoForLocalnet } from './deploy';
import { casinoLocalnetArtifactsReady } from './build-casino';
import { isArciumMxeReady, isValidatorReady, isLocalnetReady } from './localnet-health';
import {
  injectLightGenesisIntoAnchorToml,
  anchorTomlHasLightGenesis,
  pinValidatorBindAddress,
  startLightSidecars,
  lightStackStatus,
} from './light-localnet';

const REPO_ROOT = process.cwd();
const CASINO_DIR = path.join(REPO_ROOT, 'rust/casino');
const ARTIFACTS_DIR = path.join(CASINO_DIR, 'artifacts');
const COMPOSE_PATH = path.join(ARTIFACTS_DIR, 'docker-compose-arx-env.yml');
const PID_PATH = path.join(CASINO_DIR, '.localnet.pid');
const LOG_PATH = path.join(CASINO_DIR, '.localnet.log');
const ANCHOR_TOML_PATH = path.join(CASINO_DIR, 'Anchor.toml');

/** When true (default), inject Light programs/accounts into Anchor.toml during start. */
function wantsLightGenesis(): boolean {
  return process.env.LIGHT_GENESIS !== '0';
}

/** When true, start Photon + prover after MXE is ready. */
function wantsLightSidecars(): boolean {
  return process.env.LIGHT_E2E === '1' || process.env.LIGHT_SIDECARS === '1';
}

/** arcium localnet loads a large genesis; allow ample startup time. */
const VALIDATOR_TIMEOUT_MS = 1_200_000;
const ARCIUM_TIMEOUT_MS = 1_800_000;
const PROGRESS_EVERY_MS = 10_000;

export interface LocalnetOrchestratorOptions {
  /** When true, this instance spawned arcium localnet and owns teardown. */
  managed?: boolean;
  /** Mirror arcium stdout/stderr to this process (default true for managed starts). */
  streamLogs?: boolean;
}

export function isDockerRunning(): boolean {
  try {
    const env = arciumDockerEnv();
    return spawnSync(resolveDockerBinary(), ['info'], { stdio: 'pipe', env }).status === 0;
  } catch {
    return false;
  }
}

function log(msg: string): void {
  console.log(`[localnet] ${msg}`);
}

function ensureAnchorTomlWritable(anchorTomlPath = ANCHOR_TOML_PATH): void {
  try {
    fs.chmodSync(anchorTomlPath, 0o644);
  } catch {}
}

/**
 * `arcium localnet` rewrites Anchor.toml account addresses even when it
 * reuses an existing artifact. The cluster derives the account address from
 * the pubkey inside that JSON, so a stale file loaded at the new address
 * is invisible and MXE keygen never finishes.
 */
function syncArciumAccountAddresses(anchorTomlPath = ANCHOR_TOML_PATH): number {
  if (!fs.existsSync(anchorTomlPath)) return 0;
  const casinoDir = path.dirname(anchorTomlPath);
  const lines = fs.readFileSync(anchorTomlPath, 'utf8').split('\n');
  let fixes = 0;
  for (let i = 0; i < lines.length; i++) {
    const fileMatch = lines[i]?.match(/^filename = "([^"]+)"/);
    if (!fileMatch) continue;
    let addrIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (lines[j]?.startsWith('address = "')) {
        addrIdx = j;
        break;
      }
      if (lines[j]?.startsWith('[[')) break;
    }
    if (addrIdx < 0) continue;
    const rel = fileMatch[1]!;
    const full = path.isAbsolute(rel) ? rel : path.join(casinoDir, rel);
    if (!full.includes(`${path.sep}artifacts${path.sep}`)) continue;
    if (!fs.existsSync(full)) continue;
    let pubkey: string | undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as {
        pubkey?: string;
      } | Array<{ pubkey?: string }>;
      pubkey = Array.isArray(parsed) ? parsed[0]?.pubkey : parsed.pubkey;
    } catch {
      continue;
    }
    if (!pubkey) continue;
    const current = lines[addrIdx]?.match(/address = "([^"]+)"/);
    if (!current || current[1] === pubkey) continue;
    lines[addrIdx] = lines[addrIdx]!.replace(current[1]!, pubkey);
    fixes++;
  }
  if (fixes > 0) {
    fs.writeFileSync(anchorTomlPath, lines.join('\n'));
    log(`synced ${fixes} genesis account addresses to artifact pubkeys`);
  }
  return fixes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Kill leftover validator / arcium CLI / compose so a fresh start is deterministic. */
export function stopStaleLocalnet(options: { killCli?: boolean } = {}): void {
  const killCli = options.killCli ?? true;
  log('stopping stale localnet processes…');

  // Never signal this process or its parent (`bun run localnet:*` wrapper).
  const protectedPids = new Set<number>([process.pid, process.ppid].filter((p) => p > 0));

  // Prior managed pid (never signal ourselves — detach daemon writes this file).
  if (fs.existsSync(PID_PATH)) {
    try {
      const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0 && !protectedPids.has(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    } catch {}
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
  }

  spawnSync('pkill', ['-f', 'arcium localnet'], { stdio: 'pipe' });
  spawnSync('pkill', ['-f', 'solana-test-validator'], { stdio: 'pipe' });
  if (killCli) {
    // Kill *other* localnet.ts processes only — never this PID or parent bun wrapper
    // (parent cmdline also matches `scripts/localnet.ts` and used to SIGTERM restart).
    const exclude = [...protectedPids].join(' ');
    spawnSync(
      'bash',
      [
        '-lc',
        `exclude="${exclude}"; for p in $(pgrep -f 'scripts/localnet.ts' || true); do `
          + `skip=0; for e in $exclude; do [ "$p" = "$e" ] && skip=1 && break; done; `
          + `if [ "$skip" = "0" ] && [ "$p" != "$$" ]; then kill "$p" 2>/dev/null || true; fi; `
          + `done`,
      ],
      { stdio: 'pipe' },
    );
  }

  const docker = resolveDockerBinary();
  const env = arciumDockerEnv();
  if (fs.existsSync(COMPOSE_PATH)) {
    spawnSync(
      docker,
      ['compose', '-f', COMPOSE_PATH, 'down', '--remove-orphans'],
      { stdio: 'pipe', env, cwd: ARTIFACTS_DIR },
    );
  }

  // Named leftovers from older compose project names
  for (const name of [
    'artifacts-arx-node-0-1',
    'artifacts-arx-node-1-1',
    'artifacts-arcium-trusted-dealer-1',
  ]) {
    spawnSync(docker, ['rm', '-f', name], { stdio: 'pipe', env });
  }

  spawnSync('sleep', ['2'], { stdio: 'pipe' });
  resetAppleArxDhcpNetwork();
  log('stale localnet cleared');
}

export function readLocalnetPid(): number | null {
  try {
    if (!fs.existsSync(PID_PATH)) return null;
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function localnetStatus(): {
  docker: boolean;
  validator: boolean;
  mxe: boolean;
  ready: boolean;
  pid: number | null;
} {
  const docker = isDockerRunning();
  const validator = isValidatorReady();
  const mxe = isArciumMxeReady();
  return {
    docker,
    validator,
    mxe,
    ready: validator && mxe,
    pid: readLocalnetPid(),
  };
}

export class LocalnetOrchestrator {
  private arciumProcess?: ChildProcess;
  private arciumLog = '';
  private killed = false;
  readonly managed: boolean;
  private readonly streamLogs: boolean;

  constructor(options: LocalnetOrchestratorOptions = {}) {
    this.managed = options.managed ?? true;
    this.streamLogs = options.streamLogs ?? this.managed;
  }

  /**
   * Bring localnet to a fully ready state (validator + MXE).
   * Half-dead states (RPC up, MXE missing) are cleaned and restarted.
   */
  async start(): Promise<void> {
    if (isLocalnetReady()) {
      log('already ready (validator + MXE)');
      return;
    }

    if (!isDockerRunning()) {
      throw new Error(APPLE_CONTAINER_NOT_RUNNING_MESSAGE);
    }
    ensureAnchorTomlWritable();

    // Validator without MXE (or MXE without validator) → must wipe and restart.
    // Do not treat our own PID file as "stale" (detach daemon writes it first).
    const existingPid = readLocalnetPid();
    const foreignPid = existingPid !== null && existingPid !== process.pid;
    if (isValidatorReady() || isArciumMxeReady() || foreignPid) {
      log('partial localnet detected — forcing clean restart');
      stopStaleLocalnet({ killCli: false });
      await sleep(2000);
    }

    buildCasinoForLocalnet();
    if (!casinoLocalnetArtifactsReady()) {
      throw new Error(
        'Cannot start arcium localnet: build/*.arcis or target/deploy/casino.so missing. '
          + 'Run: bun run build:e2e',
      );
    }

    patchArciumDockerArtifacts();
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, '');

    // Seed Light genesis before arcium runs; re-inject if it regenerates Anchor.toml.
    if (wantsLightGenesis()) {
      const seeded = injectLightGenesisIntoAnchorToml(ANCHOR_TOML_PATH);
      if (seeded.ok) {
        log(
          `seeded Light genesis into Anchor.toml `
            + `(${seeded.programCount} programs, ${seeded.accountCount} accounts)`,
        );
      } else {
        log(`Light genesis seed skipped: ${seeded.reason}`);
      }
    }
    if (pinValidatorBindAddress(ANCHOR_TOML_PATH)) {
      log('pinned validator bind_address to host LAN IP for container RPC access');
    }
    syncArciumAccountAddresses(ANCHOR_TOML_PATH);

    const arciumBin = resolveArciumCli();
    const tdIpArg = resolveTrustedDealerIpArg();
    const [arx0, arx1] = resolveArxNodeIps();
    if (pinArciumTomlNodeIps()) {
      log(`pinned Arcium.toml nodes_ips to ${arx0}, ${arx1}`);
    }
    // Ensure compose/node genesis patches exist before arcium regenerates accounts.
    patchArciumDockerArtifacts();
    // Fresh vmnet so trusted-dealer / arx-node-0 / arx-node-1 get .2 / .3 / .4.
    resetAppleArxDhcpNetwork();
    log(
      `starting \`${arciumBin} localnet --skip-build\` `
        + `(trusted dealer IP ${tdIpArg}; arx ${arx0}, ${arx1})…`,
    );
    this.arciumProcess = spawn(
      arciumBin,
      ['localnet', '--skip-build', '--override-trusted-dealer-ip', tdIpArg],
      {
        cwd: CASINO_DIR,
        stdio: 'pipe',
        detached: false,
        env: arciumDockerEnv(),
      },
    );
    // Prefer keeping an existing daemon pid (from `localnet:start --detach`);
    // otherwise record the arcium CLI pid for stopStaleLocalnet.
    if (!fs.existsSync(PID_PATH) && this.arciumProcess.pid) {
      fs.writeFileSync(PID_PATH, String(this.arciumProcess.pid));
    }

    this.watchDockerComposeFile();
    if (wantsLightGenesis()) {
      this.watchAnchorTomlForLightGenesis();
    }
    this.arciumProcess.stdout?.on('data', (chunk) => this.onLog(chunk));
    this.arciumProcess.stderr?.on('data', (chunk) => this.onLog(chunk));
    this.arciumProcess.on('exit', (code) => {
      if (code !== 0 && code !== null && !this.killed) {
        this.onLog(`\narcium localnet exited with code ${code}\n`);
      }
      try {
        if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
      } catch {}
    });

    await this.waitForValidator(VALIDATOR_TIMEOUT_MS);
    log('validator online — waiting for Arcium MXE…');
    await this.waitForArcium(ARCIUM_TIMEOUT_MS);
    log('ready (validator + MXE)');

    if (wantsLightSidecars()) {
      log('starting Light Photon + prover sidecars…');
      startLightSidecars({ logDir: CASINO_DIR });
      for (let i = 0; i < 30; i++) {
        const st = await lightStackStatus();
        if (st.indexer && st.prover) {
          log('Light sidecars ready (indexer + prover)');
          break;
        }
        await sleep(1000);
      }
      const st = await lightStackStatus();
      if (!st.systemProgram) {
        log(
          'WARNING: Light system program still missing on-chain — '
            + 'genesis inject may have lost the race with arcium regenerating Anchor.toml',
        );
      } else if (!st.ready) {
        log(`WARNING: Light stack not fully ready (indexer=${st.indexer} prover=${st.prover})`);
      } else {
        log('Light stack ready for compressed-account CPI');
      }
    }
  }

  async stop(): Promise<void> {
    this.killed = true;
    if (this.arciumProcess) {
      try {
        this.arciumProcess.kill('SIGTERM');
      } catch {}
      await sleep(2000);
      try {
        this.arciumProcess.kill('SIGKILL');
      } catch {}
    }
    stopStaleLocalnet();
  }

  private onLog(chunk: string | Buffer): void {
    const text = chunk.toString();
    this.arciumLog += text;
    try {
      fs.appendFileSync(LOG_PATH, text);
    } catch {}
    if (this.streamLogs) {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) process.stdout.write(`[arcium] ${line}\n`);
      }
    }
  }

  private async waitForValidator(timeout: number): Promise<void> {
    const start = Date.now();
    let lastProgress = 0;
    while (Date.now() - start < timeout) {
      if (this.killed) throw new Error('Orchestrator was killed');
      if (this.arciumProcess?.exitCode != null && this.arciumProcess.exitCode !== 0) {
        throw new Error(
          `arcium localnet exited early (code ${this.arciumProcess.exitCode})\n`
            + this.arciumLog.trim().slice(-3000),
        );
      }
      if (this.arciumLog.includes('program file does not exist')) {
        throw new Error(
          'Missing casino.so — build first: bun run build:e2e\n' + this.arciumLog.trim(),
        );
      }
      if (isValidatorReady()) return;

      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = Date.now();
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        log(`waiting for validator… ${elapsed}s (see ${LOG_PATH})`);
      }
      await sleep(3000);
    }
    throw new Error(
      `Validator failed to start within ${timeout}ms\n`
        + this.arciumLog.trim().slice(-3000),
    );
  }

  private watchDockerComposeFile(): void {
    let lastMtime = 0;
    let lastMxeMtime = 0;
    const mxePath = path.join(ARTIFACTS_DIR, 'mxe_acc.json');
    const tick = () => {
      if (this.killed) return;
      try {
        const stat = fs.statSync(COMPOSE_PATH);
        if (stat.mtimeMs !== lastMtime) {
          lastMtime = stat.mtimeMs;
          patchArciumDockerArtifacts();
        }
        // arcium writes node configs after the compose file. Fill the fields
        // the v0.14.1 node requires before the container process reads them.
        ensureArxNodeConfigs();
      } catch {}
      try {
        const mxeStat = fs.statSync(mxePath);
        if (mxeStat.mtimeMs !== lastMxeMtime) {
          lastMxeMtime = mxeStat.mtimeMs;
          // arcium rewrites mxe_acc before validator boot — re-inject hand CompDef offsets.
          if (!isValidatorReady()) {
            patchMxeHandCompDefOffsets();
            padMxeAccountRecoveryFields();
            lastMxeMtime = fs.statSync(mxePath).mtimeMs;
          }
        }
      } catch {}
      setTimeout(tick, 100);
    };
    tick();
  }

  /**
   * arcium localnet regenerates Anchor.toml with `# arcium:autogenerated` blocks.
   * Re-append Light genesis whenever the marker disappears, racing before the
   * validator process is spawned from that file.
   */
  private watchAnchorTomlForLightGenesis(): void {
    let lastMtime = 0;
    let reinjects = 0;
    const tick = () => {
      if (this.killed) return;
      try {
        const stat = fs.statSync(ANCHOR_TOML_PATH);
        if (stat.mtimeMs !== lastMtime) {
          lastMtime = stat.mtimeMs;
          if (!anchorTomlHasLightGenesis(ANCHOR_TOML_PATH)) {
            const result = injectLightGenesisIntoAnchorToml(ANCHOR_TOML_PATH);
            if (result.ok) {
              reinjects++;
              log(
                `re-injected Light genesis into Anchor.toml `
                  + `(#${reinjects}, ${result.programCount} programs, ${result.accountCount} accounts)`,
              );
            }
          }
          pinValidatorBindAddress(ANCHOR_TOML_PATH);
          retargetMxeKeygenToCasinoProgram();
          syncArciumAccountAddresses(ANCHOR_TOML_PATH);
        }
      } catch {}
      // Poll aggressively until validator is up — after that genesis is fixed.
      if (!isValidatorReady()) {
        setTimeout(tick, 50);
      }
    };
    tick();
  }

  private async waitForArcium(timeout: number): Promise<void> {
    const start = Date.now();
    let lastProgress = 0;
    while (Date.now() - start < timeout) {
      if (this.killed) throw new Error('Orchestrator was killed');
      if (this.arciumProcess?.exitCode != null && this.arciumProcess.exitCode !== 0) {
        throw new Error(
          `arcium localnet exited early (code ${this.arciumProcess.exitCode})\n`
            + this.arciumLog.trim().slice(-3000),
        );
      }

      if (
        (this.arciumLog.includes('Docker daemon is not running')
          || this.arciumLog.includes('Cannot connect to the Docker daemon'))
        && !isDockerRunning()
      ) {
        throw new Error(
          `${APPLE_CONTAINER_NOT_RUNNING_MESSAGE}\n`
            + this.arciumLog.trim().slice(-2000),
        );
      }

      const pullError = arciumDockerPullError(this.arciumLog);
      if (pullError) {
        throw new Error(`${pullError}\n${this.arciumLog.trim().slice(-2000)}`);
      }

      if (isArciumMxeReady()) return;

      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = Date.now();
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const hint = this.arciumLog.includes('Primary cluster nodes are online')
          || this.arciumLog.includes('Solana localnet & Arx nodes are online')
          ? 'nodes online, MXE not ready yet'
          : 'starting arx / trusted dealer';
        log(`waiting for MXE… ${elapsed}s (${hint})`);
      }
      await sleep(5000);
    }
    throw new Error(
      `Arcium localnet failed to become ready within ${timeout}ms\n`
        + this.arciumLog.trim().slice(-3000),
    );
  }
}

export { PID_PATH, LOG_PATH, COMPOSE_PATH };
