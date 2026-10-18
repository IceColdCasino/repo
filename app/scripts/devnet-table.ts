/**
 * Devnet table helper for two native clients.
 * Prints only phase, seat count, and table ids — never an RPC URL or key.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setSharedMetaStore } from '../../src/chain/shared-meta-store';
import { ensureSharedLocalnetRoom, fetchSharedTableSnapshot } from '../../src/chain/per-seat-client';
import { beginSharedHand } from '../../src/chain/per-seat-hand';

const repoRoot = path.resolve(import.meta.dir, '../..');
const dir = path.join(repoRoot, '.local');
mkdirSync(dir, { recursive: true });

function fileFor(key: string): string {
  const name = key.endsWith('.json') ? key : `${key}.json`;
  return path.join(dir, name);
}

setSharedMetaStore({
  read(key) {
    const file = fileFor(key);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  },
  write(key, data) {
    writeFileSync(fileFor(key), data);
  },
  remove(key) {
    rmSync(fileFor(key), { force: true });
  },
});

function occupied(snapshot: { seats?: unknown[] }): number {
  return snapshot.seats?.length ?? 0;
}

const cmd = process.argv[2] ?? 'snapshot';
const rpc = process.env.SOLANA_RPC_URL;
if (!rpc) {
  throw new Error('SOLANA_RPC_URL is not set');
}

if (cmd === 'ensure') {
  const meta = await ensureSharedLocalnetRoom(rpc, { forceFresh: true });
  console.log(JSON.stringify({
    ok: true,
    roomSeed: meta.roomSeed,
    tableId: meta.tableId,
    roomIdHex: meta.roomIdHex,
  }));
} else if (cmd === 'start') {
  await beginSharedHand({ rpcUrl: rpc, gameKind: 'poker' });
  const snapshot = await fetchSharedTableSnapshot(rpc);
  console.log(JSON.stringify({
    ok: true,
    phase: snapshot.phase,
    seated: occupied(snapshot),
  }));
} else if (cmd === 'snapshot') {
  const snapshot = await fetchSharedTableSnapshot(rpc);
  console.log(JSON.stringify({
    phase: snapshot.phase ?? 'unknown',
    seated: occupied(snapshot),
    handNumber: snapshot.handNumber ?? null,
  }));
} else {
  throw new Error(`unknown command ${cmd}`);
}
