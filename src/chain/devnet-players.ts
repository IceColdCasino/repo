/**
 * Devnet e2e seat keys. Set `E2E_PLAYER_KEY_DIR` to a directory of Solana
 * keypair JSON files named `00.json` … The suite takes the next N keys for
 * each hand and wraps around. Localnet leaves the variable unset and
 * generates fresh keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { web3 } from '@coral-xyz/anchor';

function playerFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort();
}

function readPool(dir: string): web3.Keypair[] {
  return playerFiles(dir).map((name) => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as number[];
    return web3.Keypair.fromSecretKey(Uint8Array.from(raw));
  });
}

/** Next `count` seat keys, or null when the suite is not using a fixed pool. */
export function takeDevnetPlayers(count: number): web3.Keypair[] | null {
  const dir = process.env.E2E_PLAYER_KEY_DIR;
  if (!dir) return null;
  const keys = readPool(dir);
  if (keys.length < count) {
    throw new Error(
      `E2E_PLAYER_KEY_DIR has ${keys.length} keys; a hand needs ${count}`,
    );
  }
  const cursorPath = path.join(dir, '.cursor');
  const cursor = fs.existsSync(cursorPath)
    ? Number(fs.readFileSync(cursorPath, 'utf8')) || 0
    : 0;
  const start = ((cursor % keys.length) + keys.length) % keys.length;
  const out: web3.Keypair[] = [];
  for (let i = 0; i < count; i++) out.push(keys[(start + i) % keys.length]!);
  fs.writeFileSync(cursorPath, String((start + count) % keys.length));
  console.log(`[e2e] seats ${out.map((kp) => kp.publicKey.toBase58()).join(' ')}`);
  return out;
}
