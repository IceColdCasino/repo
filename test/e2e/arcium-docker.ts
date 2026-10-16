import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import {
  getArciumProgramId,
  getCompDefAccAddress,
  getRawCircuitAccAddress,
} from '@arcium-hq/client';
import { CASINO_PROGRAM_ID } from './deploy';

const ARTIFACTS_DIR = path.join(process.cwd(), 'rust/casino/artifacts');
const COMPOSE_PATH = path.join(ARTIFACTS_DIR, 'docker-compose-arx-env.yml');
const TRUSTED_DEALER_CONFIG = path.join(ARTIFACTS_DIR, 'trusted_dealer_config.toml');
const CLUSTER_ACC_PATH = path.join(ARTIFACTS_DIR, 'cluster_acc_0.json');
const ARCIUM_TOML_PATH = path.join(process.cwd(), 'rust/casino/Arcium.toml');

/** Match arcium CLI / arcium-anchor 0.14.1. Do not use :latest. */
export const ARCIUM_DOCKER_IMAGE_TAG = 'v0.14.1';

/** Avoid ipfshub_ipvcs-network on 172.20.0.0/16 (common on this dev machine). */
export const ARCIUM_DOCKER_SUBNET = '172.21.0.0/16';
/** Docker Desktop static IP for trusted dealer (compose `ipv4_address`). */
export const ARCIUM_TRUSTED_DEALER_IP_DESKTOP = '172.21.0.99';
/**
 * Apple Container cannot honor compose `ipv4_address`. On the 172.21.0.0/16
 * network, the first started service (trusted dealer) stably gets .2 via DHCP.
 */
export const ARCIUM_TRUSTED_DEALER_IP_APPLE = '172.21.0.2';
/** Docker Desktop static ARX node IPs (compose `ipv4_address`). */
export const ARCIUM_ARX_NODE_IPS_DESKTOP = ['172.21.0.100', '172.21.0.101'] as const;
/**
 * Apple Container DHCP order on a freshly created 172.21.0.0/16 network
 * when trusted-dealer starts, then arx-node-0, then arx-node-1.
 * vmnet does not reuse released leases, so the network must be deleted
 * before each localnet or the next containers walk past .2/.3/.4.
 */
export const ARCIUM_ARX_NODE_IPS_APPLE = ['172.21.0.3', '172.21.0.4'] as const;
/**
 * Start order that makes Apple Container DHCP hand out .2, then .3, then .4.
 * Later services depend on arx-node-1 so they cannot take those leases first.
 */
const APPLE_DHCP_START_AFTER: Record<string, string> = {
  'arx-node-0': 'arcium-trusted-dealer',
  'arx-node-1': 'arx-node-0',
  'arcium-backup-trusted-dealer': 'arx-node-1',
  'backup-arx-node-0': 'arcium-backup-trusted-dealer',
  'backup-arx-node-1': 'backup-arx-node-0',
};
/** Default Arcium genesis TD IP before --override-trusted-dealer-ip / our subnet remap. */
const ARCIUM_DEFAULT_TD_IP_BYTES = Buffer.from([172, 20, 0, 99]);
const ARCIUM_DESKTOP_TD_IP_BYTES = Buffer.from([172, 21, 0, 99]);
const ARCIUM_APPLE_TD_IP_BYTES = Buffer.from([172, 21, 0, 2]);
const ARCIUM_DEFAULT_NODE0_IP_BYTES = Buffer.from([172, 20, 0, 100]);
const ARCIUM_DEFAULT_NODE1_IP_BYTES = Buffer.from([172, 20, 0, 101]);
const ARCIUM_DESKTOP_NODE0_IP_BYTES = Buffer.from([172, 21, 0, 100]);
const ARCIUM_DESKTOP_NODE1_IP_BYTES = Buffer.from([172, 21, 0, 101]);
const ARCIUM_APPLE_NODE0_IP_BYTES = Buffer.from([172, 21, 0, 3]);
const ARCIUM_APPLE_NODE1_IP_BYTES = Buffer.from([172, 21, 0, 4]);
/**
 * Docker Desktop (macOS) host-gateway IPv4. Pinning avoids IPv6 `host.docker.internal`
 * resolution that breaks Arx/TD Solana RPC from containers.
 */
export const ARCIUM_DOCKER_DESKTOP_HOST_GATEWAY = '192.168.65.254';
/**
 * Fallback Apple Container host address for Solana RPC from the 172.21.0.0/16
 * Arcium network. Prefer the live en0 IP via resolveArciumDockerHostGateway().
 * (192.168.65.1 is Docker Desktop’s gateway — unreachable from Apple’s 172.21 net.)
 */
export const ARCIUM_APPLE_CONTAINER_HOST_GATEWAY = '192.168.1.90';

function homePath(...parts: string[]): string {
  return path.join(process.env.HOME ?? '', ...parts);
}

function socketExists(unixUrlOrPath: string): boolean {
  const p = unixUrlOrPath.startsWith('unix://')
    ? unixUrlOrPath.slice('unix://'.length)
    : unixUrlOrPath;
  return Boolean(p) && fs.existsSync(p);
}

/** Docker Desktop sockets — never used. Arcium localnet is Apple Container only. */
export function isDockerDesktopHost(dockerHost: string | undefined | null): boolean {
  if (!dockerHost) return false;
  return dockerHost.includes('.docker/run/docker.sock')
    || dockerHost.includes('/var/run/docker.sock')
    || dockerHost.includes('Docker.app')
    || (dockerHost.includes('docker.sock')
      && !dockerHost.includes('socktainer')
      && !dockerHost.includes('gocker'));
}

export function appleContainerBin(): string {
  return homePath('.local', 'apple-container', 'bin', 'container');
}

export function appleContainerDockerShim(): string {
  return homePath('.local', 'bin', 'docker');
}

export function isAppleContainerInstalled(): boolean {
  return fs.existsSync(appleContainerBin()) || fs.existsSync(appleContainerDockerShim());
}

/**
 * Prefer an explicit non-Desktop DOCKER_HOST, then Apple Container bridges
 * (gocker / socktainer). Never fall back to Docker Desktop.
 */
export function resolveDockerHost(): string | undefined {
  const explicit = process.env.DOCKER_HOST;
  if (explicit && !isDockerDesktopHost(explicit)) return explicit;
  const candidates = [
    homePath('.gocker', 'gocker.sock'),
    homePath('.socktainer', 'container.sock'),
  ];
  for (const sock of candidates) {
    if (socketExists(sock)) return `unix://${sock}`;
  }
  return undefined;
}

export function isAppleContainerDockerHost(dockerHost = resolveDockerHost()): boolean {
  if (process.env.ARCIUM_USE_APPLE_CONTAINER === '0') return false;
  if (process.env.ARCIUM_USE_APPLE_CONTAINER === '1') return true;
  if (!dockerHost) {
    return isAppleContainerInstalled();
  }
  return (
    dockerHost.includes('.socktainer/')
    || dockerHost.includes('.gocker/')
  );
}

/**
 * Arcium localnet uses Apple Container, not Docker Desktop.
 * Set ARCIUM_USE_APPLE_CONTAINER=0 only for an explicit unsupported escape hatch.
 */
export function isAppleContainerRuntime(): boolean {
  if (process.env.ARCIUM_USE_APPLE_CONTAINER === '0') return false;
  return true;
}

/** `docker` CLI that talks to Apple Container (never Docker.app). */
export function resolveDockerBinary(): string {
  const shim = appleContainerDockerShim();
  if (fs.existsSync(shim)) return shim;
  return 'docker';
}

export const APPLE_CONTAINER_NOT_RUNNING_MESSAGE =
  'Apple Container is not reachable. Start it (`container system start`), '
  + 'ensure ~/.local/bin/docker (Apple Container shim) is on PATH, then retry. '
  + 'Docker Desktop is not supported.';

/** Trusted-dealer IPv4 used for compose remap, genesis patch, and arcium CLI override. */
export function resolveTrustedDealerIp(): string {
  if (process.env.ARCIUM_TRUSTED_DEALER_IP) return process.env.ARCIUM_TRUSTED_DEALER_IP;
  return isAppleContainerRuntime()
    ? ARCIUM_TRUSTED_DEALER_IP_APPLE
    : ARCIUM_TRUSTED_DEALER_IP_DESKTOP;
}

export function resolveTrustedDealerIpArg(ip = resolveTrustedDealerIp()): string {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid ARCIUM trusted dealer IP: ${ip}`);
  }
  return `[${parts.join(', ')}]`;
}

function trustedDealerIpBytes(ip = resolveTrustedDealerIp()): Buffer {
  return Buffer.from(ip.split('.').map((p) => Number(p)));
}

/** ARX node IPv4s written into Arcium.toml + genesis node accounts. */
export function resolveArxNodeIps(): readonly [string, string] {
  if (process.env.ARCIUM_ARX_NODE_IPS) {
    const parts = process.env.ARCIUM_ARX_NODE_IPS.split(',').map((s) => s.trim());
    if (parts.length >= 2) return [parts[0]!, parts[1]!];
  }
  return isAppleContainerRuntime()
    ? ARCIUM_ARX_NODE_IPS_APPLE
    : ARCIUM_ARX_NODE_IPS_DESKTOP;
}

function ipToBytes(ip: string): Buffer {
  return Buffer.from(ip.split('.').map((p) => Number(p)));
}

function ipToTomlArray(ip: string): string {
  return `[${ip.split('.').map((p) => Number(p)).join(', ')}]`;
}

/** @deprecated use resolveTrustedDealerIp() */
export const ARCIUM_TRUSTED_DEALER_IP = ARCIUM_TRUSTED_DEALER_IP_DESKTOP;
/** @deprecated use resolveTrustedDealerIpArg() */
export const ARCIUM_TRUSTED_DEALER_IP_ARG = '[172, 21, 0, 99]';

/** Prefer macOS en0 IPv4 (reachable from Apple Container 172.21.0.0/16). */
export function resolveHostLanIp(): string | undefined {
  if (process.env.SOLANA_BIND_ADDRESS) return process.env.SOLANA_BIND_ADDRESS;
  if (process.env.ARCIUM_DOCKER_HOST_GATEWAY) {
    return process.env.ARCIUM_DOCKER_HOST_GATEWAY;
  }
  try {
    const r = Bun.spawnSync(['ipconfig', 'getifaddr', 'en0'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const ip = r.stdout.toString().trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Host IPv4 that containers should use for the Mac (Solana RPC, etc.). */
export function resolveArciumDockerHostGateway(
  _dockerHost = resolveDockerHost(),
): string {
  if (process.env.ARCIUM_DOCKER_HOST_GATEWAY) {
    return process.env.ARCIUM_DOCKER_HOST_GATEWAY;
  }
  if (isAppleContainerRuntime()) {
    return resolveHostLanIp() ?? ARCIUM_APPLE_CONTAINER_HOST_GATEWAY;
  }
  return ARCIUM_DOCKER_DESKTOP_HOST_GATEWAY;
}

/** @deprecated use resolveArciumDockerHostGateway() */
export const ARCIUM_DOCKER_HOST_GATEWAY = ARCIUM_APPLE_CONTAINER_HOST_GATEWAY;

function pathWithLocalBins(basePath = process.env.PATH ?? ''): string {
  const home = process.env.HOME ?? '';
  const prefixes = [
    // Repo shim keeps stdin open for `anchor localnet` (Anchor 0.32.1 EOF panic).
    path.join(process.cwd(), 'scripts', 'bin'),
    path.join(home, '.local', 'apple-container', 'bin'),
    path.join(home, '.local', 'bin'),
  ].filter(Boolean);
  const parts = basePath.split(path.delimiter).filter(Boolean);
  const ordered = [...prefixes, ...parts.filter((p) => !prefixes.includes(p))];
  return ordered.join(path.delimiter);
}

/**
 * Apple Silicon: Arcium images are amd64-only; run under Rosetta on Apple Container.
 * PATH prefers the Apple Container `docker` shim. Docker Desktop sockets are stripped.
 */
export function arciumDockerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: pathWithLocalBins(base.PATH),
    DOCKER_DEFAULT_PLATFORM: 'linux/amd64',
  };
  if (isAppleContainerRuntime()) {
    env.ARCIUM_USE_APPLE_CONTAINER = '1';
    // Shim talks to Apple Container directly — inherited Desktop DOCKER_HOST breaks it.
    delete env.DOCKER_HOST;
  } else if (isDockerDesktopHost(env.DOCKER_HOST)) {
    delete env.DOCKER_HOST;
  }
  return env;
}

/**
 * House images are linux/arm64. libzkcasino refuses every other Linux arch.
 * Same Apple Container shim as Arcium, without the amd64 platform pin.
 */
export function houseImageDockerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: pathWithLocalBins(base.PATH),
    DOCKER_DEFAULT_PLATFORM: 'linux/arm64',
  };
  if (isAppleContainerRuntime()) {
    env.ARCIUM_USE_APPLE_CONTAINER = '1';
    delete env.DOCKER_HOST;
  } else if (isDockerDesktopHost(env.DOCKER_HOST)) {
    delete env.DOCKER_HOST;
  }
  return env;
}

/** Snapshot at import; prefer `arciumDockerEnv()` for a fresh env. */
export const ARCIUM_DOCKER_ENV: NodeJS.ProcessEnv = arciumDockerEnv();

function remapArciumSubnet(text: string): string {
  const td = resolveTrustedDealerIp();
  let next = text
    .replace(/subnet: 172\.20\.0\.0\/16/g, `subnet: ${ARCIUM_DOCKER_SUBNET}`)
    .replace(/ipv4_address: 172\.20\.0\.99/g, `ipv4_address: ${td}`)
    .replace(/local_ip = "172\.20\.0\.99"/g, `local_ip = "${td}"`)
    // Desktop leftover → Apple DHCP assignment (or explicit override).
    .replace(/ipv4_address: 172\.21\.0\.99/g, `ipv4_address: ${td}`)
    .replace(/local_ip = "172\.21\.0\.99"/g, `local_ip = "${td}"`);
  if (isAppleContainerRuntime()) {
    // Document expected DHCP order (compose ipv4_address is ignored by Apple).
    next = next
      .replace(/ipv4_address: 172\.21\.0\.100/g, 'ipv4_address: 172.21.0.3')
      .replace(/ipv4_address: 172\.21\.0\.101/g, 'ipv4_address: 172.21.0.4');
  }
  return next;
}

/** Force primary Arx services to start before backup so DHCP yields .2/.3/.4. */
function pinAppleDhcpStartOrder(text: string): string {
  if (!isAppleContainerRuntime()) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const match = line.match(/^  ([a-z0-9-]+):\s*$/);
    const dep = match ? APPLE_DHCP_START_AFTER[match[1]!] : undefined;
    if (!dep) continue;
    const next = lines[i + 1] ?? '';
    if (/^\s+depends_on:/.test(next)) continue;
    out.push('    depends_on:');
    out.push(`      - ${dep}`);
  }
  return out.join('\n');
}

/**
 * Apple Container vmnet keeps DHCP leases after containers are removed.
 * Drop the Arcium network so the next compose starts again at 172.21.0.2.
 */
export function resetAppleArxDhcpNetwork(): void {
  if (!isAppleContainerRuntime()) return;
  const bin = appleContainerBin();
  if (!fs.existsSync(bin)) return;
  const env = arciumDockerEnv();
  for (const name of [
    'artifacts-arcium-trusted-dealer',
    'artifacts-arcium-backup-trusted-dealer',
    'artifacts-arx-node-0',
    'artifacts-arx-node-1',
    'artifacts-backup-arx-node-0',
    'artifacts-backup-arx-node-1',
  ]) {
    spawnSync(bin, ['stop', name], { stdio: 'pipe', env });
    spawnSync(bin, ['rm', '-f', name], { stdio: 'pipe', env });
  }
  spawnSync(bin, ['network', 'rm', 'artifacts-arx_network'], { stdio: 'pipe', env });
}

function pinArciumImageTags(text: string): string {
  return text.replace(
    /image: "arcium\/([^":]+):[^"]+"/g,
    `image: "arcium/$1:${ARCIUM_DOCKER_IMAGE_TAG}"`,
  );
}

/** Collapse runaway blank lines (seen when compose artifacts get corrupted). */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Force IPv4 host gateway so containers can reach solana-test-validator on :8899.
 * Apple container-compose ignores `extra_hosts`, so strip those blocks and rewrite
 * `host.docker.internal` URLs/env to the gateway IP.
 */
function pinDockerHostGateway(text: string): string {
  const gateway = resolveArciumDockerHostGateway();
  if (isAppleContainerRuntime()) {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*extra_hosts:\s*$/.test(line)) {
        // Skip the key and any host.docker.internal entries under it.
        while (i + 1 < lines.length && /^\s*-\s*"?host\.docker\.internal:/.test(lines[i + 1]!)) {
          i++;
        }
        continue;
      }
      if (/^\s*-\s*"?host\.docker\.internal:/.test(line)) continue;
      out.push(line.replace(/host\.docker\.internal/g, gateway));
    }
    return collapseBlankLines(out.join('\n'));
  }
  return collapseBlankLines(
    text
      .replace(
        /host\.docker\.internal:host-gateway/g,
        `host.docker.internal:${gateway}`,
      )
      .replace(
        /host\.docker\.internal:\d+\.\d+\.\d+\.\d+/g,
        `host.docker.internal:${gateway}`,
      ),
  );
}

/**
 * After `arcium clean --only-accounts`, genesis `cluster_acc_0.json` embeds TD IP
 * `172.20.0.99`. Our compose remaps TD to `172.21.0.99`; without this patch Arx
 * dials the wrong address and MXE keygen never sets X25519.
 */
function rewriteIpBytes(raw: Buffer, sources: Buffer[], target: Buffer): boolean {
  let changed = false;
  for (let i = 0; i <= raw.length - 4; i++) {
    const slice = raw.subarray(i, i + 4);
    if (sources.some((s) => slice.equals(s)) && !slice.equals(target)) {
      target.copy(raw, i);
      changed = true;
    }
  }
  return changed;
}

export function patchClusterTrustedDealerIp(): void {
  if (!fs.existsSync(CLUSTER_ACC_PATH)) return;
  const acc = JSON.parse(fs.readFileSync(CLUSTER_ACC_PATH, 'utf8')) as {
    account: { data: [string, string] };
  };
  const raw = Buffer.from(acc.account.data[0], 'base64');
  const changed = rewriteIpBytes(
    raw,
    [ARCIUM_DEFAULT_TD_IP_BYTES, ARCIUM_DESKTOP_TD_IP_BYTES, ARCIUM_APPLE_TD_IP_BYTES],
    trustedDealerIpBytes(),
  );
  if (!changed) return;
  acc.account.data[0] = raw.toString('base64');
  fs.writeFileSync(CLUSTER_ACC_PATH, JSON.stringify(acc, null, 2) + '\n');
}

/**
 * Pin Arcium.toml nodes_ips to the runtime’s expected ARX addresses.
 * Apple Container DHCP cannot honor compose ipv4_address, so genesis must
 * advertise .3/.4 (not Desktop’s .100/.101).
 */
export function pinArciumTomlNodeIps(
  arciumTomlPath: string = ARCIUM_TOML_PATH,
): boolean {
  if (!fs.existsSync(arciumTomlPath)) return false;
  const [ip0, ip1] = resolveArxNodeIps();
  const text = fs.readFileSync(arciumTomlPath, 'utf8');
  const block =
    `nodes_ips = [\n`
    + `  ${ipToTomlArray(ip0)},\n`
    + `  ${ipToTomlArray(ip1)}\n`
    + `]`;
  let next: string;
  // Match the full multi-line array (inner `[172, …]` must not truncate the replace).
  const nodesIpsRe = /nodes_ips\s*=\s*\[[\s\S]*?\n\]/;
  if (nodesIpsRe.test(text)) {
    next = text.replace(nodesIpsRe, block);
  } else if (text.includes('[localnet]')) {
    next = text.replace(/\[localnet\]/, `[localnet]\n${block}`);
  } else {
    return false;
  }
  if (next === text) return false;
  fs.writeFileSync(arciumTomlPath, next);
  return true;
}

/** Rewrite genesis arx_node_*.json IP bytes to match resolveArxNodeIps(). */
export function patchArxNodeAccountIps(): void {
  if (!fs.existsSync(ARTIFACTS_DIR)) return;
  const [ip0, ip1] = resolveArxNodeIps();
  const target0 = ipToBytes(ip0);
  const target1 = ipToBytes(ip1);
  const sources0 = [
    ARCIUM_DEFAULT_NODE0_IP_BYTES,
    ARCIUM_DESKTOP_NODE0_IP_BYTES,
    ARCIUM_APPLE_NODE0_IP_BYTES,
  ];
  const sources1 = [
    ARCIUM_DEFAULT_NODE1_IP_BYTES,
    ARCIUM_DESKTOP_NODE1_IP_BYTES,
    ARCIUM_APPLE_NODE1_IP_BYTES,
  ];

  for (const name of fs.readdirSync(ARTIFACTS_DIR)) {
    if (!name.startsWith('arx_node_') || !name.endsWith('.json')) continue;
    const p = path.join(ARTIFACTS_DIR, name);
    let acc: { account: { data: [string, string] } };
    try {
      acc = JSON.parse(fs.readFileSync(p, 'utf8')) as {
        account: { data: [string, string] };
      };
    } catch {
      continue;
    }
    if (!acc?.account?.data?.[0]) continue;
    const raw = Buffer.from(acc.account.data[0], 'base64');
    // Prefer matching the current Desktop/default bytes so node0/node1 don’t swap.
    let changed = false;
    if (
      raw.includes(ARCIUM_DESKTOP_NODE0_IP_BYTES)
      || raw.includes(ARCIUM_DEFAULT_NODE0_IP_BYTES)
      || raw.includes(ARCIUM_APPLE_NODE0_IP_BYTES)
    ) {
      changed = rewriteIpBytes(raw, sources0, target0) || changed;
    }
    if (
      raw.includes(ARCIUM_DESKTOP_NODE1_IP_BYTES)
      || raw.includes(ARCIUM_DEFAULT_NODE1_IP_BYTES)
      || raw.includes(ARCIUM_APPLE_NODE1_IP_BYTES)
    ) {
      changed = rewriteIpBytes(raw, sources1, target1) || changed;
    }
    if (!changed) continue;
    acc.account.data[0] = raw.toString('base64');
    fs.writeFileSync(p, JSON.stringify(acc, null, 2) + '\n');
  }
}

/**
 * Circuits with a genesis-loaded CompDef account (see Anchor.toml).
 * Those accounts skip `init_comp_def`, so their offsets must already be in
 * `mxe_acc.json` or queue fails with InvalidComputationDefinition (orphan).
 *
 * Do NOT list circuits that are init'd at runtime — pre-listing their offsets
 * makes InitComputationDefinition fail with the same error.
 * Arcium CLI 0.14 does not emit per-circuit comp-def genesis files, so this
 * list stays empty and the e2e uploads CompDefs after the validator is up.
 */
export const HAND_COMP_DEF_CIRCUITS = [] as const;

/**
 * Ensure genesis MXE lists all hand CompDef offsets. Safe to call whenever
 * arcium regenerates `mxe_acc.json` (before validator loads genesis).
 *
 * Delegates to `scripts/patch-mxe-comp-def-offsets.ts` (async Borsh encode).
 */
export function patchMxeHandCompDefOffsets(): void {
  const mxePath = path.join(ARTIFACTS_DIR, 'mxe_acc.json');
  if (!fs.existsSync(mxePath)) return;
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const script = path.join(process.cwd(), 'scripts/patch-mxe-comp-def-offsets.ts');
  if (!fs.existsSync(script)) return;
  const r = spawnSync(
    process.execPath,
    [script, ...HAND_COMP_DEF_CIRCUITS],
    { cwd: process.cwd(), encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0 && r.stderr) {
    console.warn('[arcium-docker] patch-mxe-comp-def-offsets:', r.stderr.slice(0, 400));
  }
}

/** sha256("account:MXEAccount")[..8] */
const MXE_ACCOUNT_DISC = Buffer.from([103, 26, 85, 250, 179, 159, 17, 117]);
const UTILITY_PUBKEYS_LEN = 32 + 32 + 32 + 64;

/**
 * arcium CLI 0.9.7 writes an MXE account that stops at `bump`. arx-node
 * v0.14.1 also reads `current_epoch_recovery_rewards` and
 * `recovery_rewards_epoch` (two u64s). The keygen callback then fails with
 * AccountDidNotDeserialize and X25519 stays unset. Append those zeros before
 * the validator loads genesis. A complete account is left alone.
 */
export function padMxeAccountRecoveryFields(): void {
  const mxePath = path.join(ARTIFACTS_DIR, 'mxe_acc.json');
  if (!fs.existsSync(mxePath)) return;
  let parsed: GenesisAccountFile | GenesisAccountFile[];
  try {
    parsed = JSON.parse(fs.readFileSync(mxePath, 'utf8')) as GenesisAccountFile | GenesisAccountFile[];
  } catch {
    return;
  }
  const acc = Array.isArray(parsed) ? parsed[0] : parsed;
  const dataB64 = acc?.account?.data?.[0];
  if (!dataB64) return;
  const raw = Buffer.from(dataB64, 'base64');
  if (raw.length < 8 || !raw.subarray(0, 8).equals(MXE_ACCOUNT_DISC)) return;
  let o = 8 + 1 + 4 + 8 + 8 + 32;
  if (o >= raw.length) return;
  const auth = raw[o++];
  if (auth === 1) o += 32;
  else if (auth !== 0) return;
  if (o >= raw.length) return;
  const util = raw[o++];
  if (util !== 0 && util !== 1) return;
  o += UTILITY_PUBKEYS_LEN;
  if (util === 1) {
    if (o + 4 > raw.length) return;
    const flags = raw.readUInt32LE(o);
    o += 4;
    if (flags > 64 || o + flags > raw.length) return;
    o += flags;
  }
  if (o + 4 > raw.length) return;
  const defs = raw.readUInt32LE(o);
  o += 4;
  if (defs > 1024 || o + defs * 4 + 2 > raw.length) return;
  o += defs * 4 + 2;
  if (o + 16 === raw.length) return;
  if (o !== raw.length) return;
  const next = Buffer.concat([raw, Buffer.alloc(16)]);
  acc.account!.data![0] = next.toString('base64');
  fs.writeFileSync(mxePath, JSON.stringify(parsed, null, 2) + '\n');
  console.log('[arcium-docker] padded MXE account with recovery reward fields');
}

/** ComputationAccount discriminator (sha256("account:ComputationAccount")[..8]). */
const COMPUTATION_ACCOUNT_DISC = Buffer.from([136, 34, 167, 71, 41, 174, 103, 77]);
/** ComputationDefinitionAccount ends with bump: u8 + padding: [u8; 24]. */
const COMP_DEF_BUMP_FROM_END = 25;

type GenesisAccountFile = {
  pubkey?: string;
  account?: { data?: [string, string] };
};

function compDefBump(mxeProgram: PublicKey, offset: number): number {
  const off = Buffer.alloc(4);
  off.writeUInt32LE(offset, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ComputationDefinitionAccount'), mxeProgram.toBuffer(), off],
    getArciumProgramId(),
  )[1];
}

/**
 * Genesis keygen still names an MXE program that is not the deployed casino
 * program. Nodes finish MPC, then the callback looks up that program's MXE
 * account and never writes X25519 onto the casino MXE `mxe-info` reads.
 * Rewrite the queued computation (and its comp-def PDA + bump) onto
 * `CASINO_PROGRAM_ID` before Anchor loads genesis.
 */
export function retargetMxeKeygenToCasinoProgram(
  programIdBase58: string = CASINO_PROGRAM_ID,
): number {
  if (!fs.existsSync(ARTIFACTS_DIR)) return 0;
  const casino = new PublicKey(programIdBase58);
  const byPubkey = new Map<string, string>();
  for (const name of fs.readdirSync(ARTIFACTS_DIR)) {
    if (!name.endsWith('.json')) continue;
    let pubkey: string | undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, name), 'utf8')) as
        | GenesisAccountFile
        | GenesisAccountFile[];
      pubkey = (Array.isArray(parsed) ? parsed[0] : parsed)?.pubkey;
    } catch {
      continue;
    }
    if (pubkey) byPubkey.set(pubkey, name);
  }

  let changes = 0;
  for (const name of [...byPubkey.values()]) {
    const filePath = path.join(ARTIFACTS_DIR, name);
    let text: string;
    let parsed: GenesisAccountFile | GenesisAccountFile[];
    try {
      text = fs.readFileSync(filePath, 'utf8');
      parsed = JSON.parse(text) as GenesisAccountFile | GenesisAccountFile[];
    } catch {
      continue;
    }
    const acc = Array.isArray(parsed) ? parsed[0] : parsed;
    const dataB64 = acc?.account?.data?.[0];
    if (!dataB64 || !acc?.pubkey) continue;
    const raw = Buffer.from(dataB64, 'base64');
    if (raw.length < 76 || !raw.subarray(0, 8).equals(COMPUTATION_ACCOUNT_DISC)) continue;
    const embedded = new PublicKey(raw.subarray(40, 72));
    if (embedded.equals(casino)) continue;

    const offset = raw.readUInt32LE(72);
    const oldDef = getCompDefAccAddress(embedded, offset);
    const newDef = getCompDefAccAddress(casino, offset);
    const defName = byPubkey.get(oldDef.toBase58());
    if (!defName) {
      console.warn(
        `[arcium-docker] leaving ${name} on MXE ${embedded.toBase58()}: `
          + `no comp def at ${oldDef.toBase58()} (offset ${offset})`,
      );
      continue;
    }
    for (let i = 0; i < 256; i++) {
      const oldRaw = getRawCircuitAccAddress(oldDef, i).toBase58();
      const rawName = byPubkey.get(oldRaw);
      if (rawName) {
        throw new Error(
          `Cannot retarget ${defName}: raw circuit ${rawName} is still bound to ${oldRaw}`,
        );
      }
    }
    retargetCompDefFile(defName, byPubkey, oldDef, newDef, embedded, casino, offset);

    casino.toBuffer().copy(raw, 40);
    const nextB64 = raw.toString('base64');
    const nextText = text.replace(dataB64, nextB64);
    if (nextText === text) {
      throw new Error(`Failed to rewrite MXE program id in ${name}`);
    }
    fs.writeFileSync(filePath, nextText);
    console.log(
      `[arcium-docker] retargeted ${name} MXE ${embedded.toBase58()} -> ${casino.toBase58()} `
        + `(comp def offset ${offset})`,
    );
    changes++;
  }
  return changes;
}

function retargetCompDefFile(
  defName: string,
  byPubkey: Map<string, string>,
  oldDef: PublicKey,
  newDef: PublicKey,
  oldProgram: PublicKey,
  casino: PublicKey,
  offset: number,
): void {
  const filePath = path.join(ARTIFACTS_DIR, defName);
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as GenesisAccountFile | GenesisAccountFile[];
  const acc = Array.isArray(parsed) ? parsed[0] : parsed;
  const dataB64 = acc?.account?.data?.[0];
  const pubkey = acc?.pubkey;
  if (!dataB64 || pubkey !== oldDef.toBase58()) {
    throw new Error(`Comp def ${defName} pubkey ${pubkey} is not ${oldDef.toBase58()}`);
  }
  const raw = Buffer.from(dataB64, 'base64');
  const bumpAt = raw.length - COMP_DEF_BUMP_FROM_END;
  const oldBump = compDefBump(oldProgram, offset);
  const newBump = compDefBump(casino, offset);
  if (bumpAt < 8 || raw[bumpAt] !== oldBump) {
    throw new Error(
      `Comp def ${defName} bump byte ${raw[bumpAt]} != PDA bump ${oldBump} for ${oldProgram.toBase58()}`,
    );
  }
  raw[bumpAt] = newBump;
  let next = text.replace(dataB64, raw.toString('base64')).replace(pubkey, newDef.toBase58());
  if (next === text || next.includes(pubkey)) {
    throw new Error(`Failed to retarget comp def ${defName} to ${newDef.toBase58()}`);
  }
  fs.writeFileSync(filePath, next);
  byPubkey.delete(pubkey);
  byPubkey.set(newDef.toBase58(), defName);
  console.log(
    `[arcium-docker] retargeted ${defName} ${pubkey} -> ${newDef.toBase58()} (bump ${newBump})`,
  );
}

/** Patch generated compose + trusted-dealer config for Apple Silicon + subnet conflicts. */
export function patchArciumDockerArtifacts(): void {
  retargetMxeKeygenToCasinoProgram();
  pinArciumTomlNodeIps();
  patchArxNodeAccountIps();
  try {
    patchMxeHandCompDefOffsets();
    padMxeAccountRecoveryFields();
  } catch (e) {
    // Best-effort — localnet can still start; ensureCompDefs will surface orphans.
    console.warn('[arcium-docker] patchMxeHandCompDefOffsets failed:', e);
  }
  if (fs.existsSync(COMPOSE_PATH)) {
    const text = fs.readFileSync(COMPOSE_PATH, 'utf8');
    const lines = pinDockerHostGateway(
      pinAppleDhcpStartOrder(pinArciumImageTags(remapArciumSubnet(text))),
    ).split('\n');
    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      out.push(line);
      if (line.includes('image: "arcium/') && !line.includes('platform:')) {
        const next = lines[i + 1] ?? '';
        if (!next.includes('platform:')) {
          out.push('    platform: linux/amd64');
        }
      }
      // Share-hash EncData OOMs under Apple Container's default 1GiB for amd64
      // ARX nodes — bump before Cerberus online phase.
      if (
        /^\s+platform:\s*linux\/amd64\s*$/.test(line)
        && !lines.slice(Math.max(0, i - 3), i + 4).some((l) => /mem_limit:/.test(l))
      ) {
        out.push('    mem_limit: 4g');
      }
    }

    const nextText = out.join('\n') + (text.endsWith('\n') ? '\n' : '');
    if (nextText !== text) {
      fs.writeFileSync(COMPOSE_PATH, nextText);
    }
  }

  if (fs.existsSync(TRUSTED_DEALER_CONFIG)) {
    const text = fs.readFileSync(TRUSTED_DEALER_CONFIG, 'utf8');
    const next = pinDockerHostGateway(remapArciumSubnet(text));
    if (next !== text) fs.writeFileSync(TRUSTED_DEALER_CONFIG, next);
  }

  // Node configs also embed host.docker.internal for Solana RPC/WSS.
  ensureArxNodeConfigs();

  patchClusterTrustedDealerIp();
}

export function arciumDockerPullError(log: string): string | null {
  if (
    log.includes('linux/arm64/v8')
    || log.includes('no match for platform in manifest')
  ) {
    return (
      'Arcium Docker images have no ARM64 build. '
      + 'Ensure DOCKER_DEFAULT_PLATFORM=linux/amd64 (see test/e2e/arcium-docker.ts).'
    );
  }
  if (log.includes('Pool overlaps with other one on this address space')) {
    return (
      'Arcium docker network 172.20.0.0/16 conflicts with another Docker network '
      + `(e.g. ipfshub). Expected subnet ${ARCIUM_DOCKER_SUBNET}.`
    );
  }
  return null;
}

/**
 * arx-node v0.14.1 rejects a node config that omits `computations_limit` or
 * the secondary Solana endpoints. `arcium localnet` still writes the shorter
 * file, so fill those in before the container reads it.
 */
export function ensureArxNodeConfigs(): void {
  if (!fs.existsSync(ARTIFACTS_DIR)) return;
  for (const name of fs.readdirSync(ARTIFACTS_DIR)) {
    if (!name.startsWith('node_config') || !name.endsWith('.toml')) continue;
    const filePath = path.join(ARTIFACTS_DIR, name);
    const text = fs.readFileSync(filePath, 'utf8');
    let next = isAppleContainerRuntime() ? pinDockerHostGateway(text) : text;
    if (!/^computations_limit\s*=/m.test(next)) {
      next = next.replace(/(\[node\]\r?\n)/, '$1computations_limit = 10\n');
    }
    if (!/^secondary_endpoint_rpc\s*=/m.test(next)) {
      const rpc = next.match(/^endpoint_rpc\s*=\s*"([^"]+)"/m)?.[1];
      const wss = next.match(/^endpoint_wss\s*=\s*"([^"]+)"/m)?.[1];
      if (rpc && wss) {
        next = next.replace(
          /^(endpoint_wss\s*=\s*"[^"]+"\r?\n)/m,
          `$1secondary_endpoint_rpc = "${rpc}"\nsecondary_endpoint_wss = "${wss}"\n`,
        );
      }
    }
    if (next !== text) fs.writeFileSync(filePath, next);
  }
}

/** @deprecated use patchArciumDockerArtifacts */
export const patchArciumDockerComposePlatform = patchArciumDockerArtifacts;
