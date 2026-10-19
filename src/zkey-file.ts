import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const RAW = 'zkey';
const STORED = 'zkx1';

function cacheDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library/Caches/IceColdCasino/zkey');
  }
  return join('/tmp', 'icecoldcasino-zkey');
}

function xzBin(): string {
  for (const candidate of ['/opt/homebrew/bin/xz', '/usr/local/bin/xz']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'xz';
}

function shellQuote(path: string): string {
  if (path.includes("'")) throw new Error(`zkey path cannot be quoted: ${path}`);
  return `'${path}'`;
}

/** Path whose bytes are the raw proving key. xz storage expands once into the cache. */
export function plainZkeyPath(stored: string): string {
  const fd = openSync(stored, 'r');
  const head = Buffer.alloc(12);
  let n = 0;
  try {
    n = readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const magic = head.subarray(0, 4).toString('ascii');
  if (n >= 4 && magic === RAW) return stored;
  if (n < 12 || magic !== STORED) throw new Error(`unrecognized zkey ${stored}`);

  const uncompressed = Number(head.readBigUInt64LE(4));
  const st = statSync(stored);
  const dir = cacheDir();
  const cache = join(dir, `${basename(stored)}.${Math.floor(st.mtimeMs / 1000)}.${st.size}.zkey`);
  if (existsSync(cache) && statSync(cache).size === uncompressed) return cache;

  mkdirSync(dir, { recursive: true });
  const partial = `${cache}.partial`;
  const cmd = `tail -c +13 ${shellQuote(stored)} | ${shellQuote(xzBin())} -dc > ${shellQuote(partial)} && mv ${shellQuote(partial)} ${shellQuote(cache)}`;
  const result = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    throw new Error(detail.length > 0 ? detail : `xz expand failed for ${stored}`);
  }
  if (!existsSync(cache) || statSync(cache).size !== uncompressed) {
    throw new Error(`xz expand size mismatch for ${stored}`);
  }
  return cache;
}
