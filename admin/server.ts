/**
 * Localhost admin. Binds to 127.0.0.1 only.
 * Creates room and table accounts, whitelists players, and funds SOL floats.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  CLUSTERS,
  GAME_ROOM_TYPES,
  WHITELIST_ADMIN,
  connectionFor,
  executeLocal,
  explain,
  inspectRoom,
  isCluster,
  isGame,
  listClusterRooms,
  listRoomWhitelist,
  plan,
  quoteGameFloatOnCluster,
  sendSigned,
  type ClusterId,
  type GameRoomType,
  type PlanRequest,
  type RememberedRoom,
  type Step,
} from './chain';

const PORT = Number(process.env.ADMIN_PORT ?? 8787);
const PUBLIC = join(import.meta.dir, 'public');
const MEMORY = join(import.meta.dir, 'data', 'rooms.json');

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'browser.ts')],
  outdir: PUBLIC,
  target: 'browser',
  naming: 'app.[ext]',
  sourcemap: 'none',
});
if (!built.success) {
  console.error(built.logs);
  throw new Error('Admin page failed to build.');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function readCluster(value: unknown): ClusterId {
  if (typeof value !== 'string' || !isCluster(value)) {
    throw new Error('Pick localnet or devnet.');
  }
  return value;
}

function readGame(value: unknown): GameRoomType {
  if (typeof value !== 'string' || !isGame(value)) throw new Error('Pick a game.');
  return value;
}

function readPlan(body: Record<string, unknown>): PlanRequest {
  const players = Array.isArray(body.players)
    ? body.players.filter((item): item is string => typeof item === 'string')
    : [];
  let floatLamports: number | null = null;
  if (typeof body.floatLamports === 'number' && Number.isInteger(body.floatLamports)) {
    if (body.floatLamports < 0 || body.floatLamports > 20 * LAMPORTS_PER_SOL) {
      throw new Error('Float has to be between 0 and 20 SOL per address.');
    }
    floatLamports = body.floatLamports;
  } else if (body.floatSol !== undefined && body.floatSol !== null && body.floatSol !== '') {
    const sol = typeof body.floatSol === 'number' ? body.floatSol : Number(body.floatSol);
    if (!Number.isFinite(sol) || sol < 0 || sol > 20) {
      throw new Error('Float has to be between 0 and 20 SOL per address.');
    }
    floatLamports = Math.round(sol * LAMPORTS_PER_SOL);
  }
  const smallBlind = Number(body.smallBlind ?? 10);
  return {
    cluster: readCluster(body.cluster),
    game: readGame(body.game),
    seed: typeof body.seed === 'string' ? body.seed : '',
    smallBlind,
    openTable: body.openTable === true,
    createRoom: body.createRoom === true,
    whitelist: body.whitelist === true,
    fund: body.fund === true,
    shoeDecks: body.shoeDecks === undefined ? undefined : Number(body.shoeDecks),
    rouletteVariant: body.rouletteVariant === undefined ? undefined : Number(body.rouletteVariant),
    players,
    floatLamports,
    roomIdHex: typeof body.roomId === 'string' ? body.roomId : '',
    closeTableId: typeof body.closeTableId === 'number' && Number.isInteger(body.closeTableId)
      ? body.closeTableId
      : null,
  };
}

function rememberedRooms(): RememberedRoom[] {
  try {
    const parsed = JSON.parse(readFileSync(MEMORY, 'utf8')) as RememberedRoom[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && isGame(row.game) && typeof row.seed === 'string' && typeof row.roomId === 'string');
  } catch {
    return [];
  }
}

function rememberRoom(row: RememberedRoom): void {
  const rooms = rememberedRooms().filter((item) => item.roomId.toLowerCase() !== row.roomId.toLowerCase());
  rooms.push(row);
  mkdirSync(join(import.meta.dir, 'data'), { recursive: true });
  writeFileSync(MEMORY, JSON.stringify(rooms, null, 2));
}

function readSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('Nothing to sign.');
  }
  return value.map((step) => {
    if (!step || typeof step !== 'object') throw new Error('Bad transaction.');
    const row = step as Record<string, unknown>;
    if (typeof row.label !== 'string' || typeof row.tx !== 'string') {
      throw new Error('Bad transaction.');
    }
    if (typeof row.blockhash !== 'string' || typeof row.lastValidBlockHeight !== 'number') {
      throw new Error('Bad transaction.');
    }
    return {
      label: row.label,
      tx: row.tx,
      blockhash: row.blockhash,
      lastValidBlockHeight: row.lastValidBlockHeight,
    };
  });
}

async function api(req: Request, url: URL): Promise<Response> {
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json({
        admin: WHITELIST_ADMIN.toBase58(),
        clusters: CLUSTERS,
        games: GAME_ROOM_TYPES,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/float') {
      const cluster = readCluster(url.searchParams.get('cluster') ?? '');
      const game = readGame(url.searchParams.get('game') ?? '');
      const shoe = url.searchParams.get('shoe');
      const variant = url.searchParams.get('variant');
      const quote = await quoteGameFloatOnCluster(
        cluster,
        game,
        shoe ? Number(shoe) : undefined,
        variant ? Number(variant) : undefined,
      );
      return json(quote);
    }
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      const cluster = readCluster(url.searchParams.get('cluster') ?? '');
      const rooms = await listClusterRooms(cluster, rememberedRooms());
      return json({ rooms });
    }
    if (req.method === 'GET' && url.pathname === '/api/whitelist') {
      const cluster = readCluster(url.searchParams.get('cluster') ?? '');
      const roomId = (url.searchParams.get('roomId') ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(roomId)) throw new Error('Pick a room.');
      const players = await listRoomWhitelist(cluster, roomId);
      return json({ players });
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms/remember') {
      const body = await req.json() as Record<string, unknown>;
      const game = readGame(body.game);
      const seed = typeof body.seed === 'string' ? body.seed.trim() : '';
      const roomId = typeof body.roomId === 'string' ? body.roomId.trim().toLowerCase() : '';
      if (!seed || !/^[0-9a-f]{64}$/.test(roomId)) throw new Error('Room memory needs a seed and a room id.');
      rememberRoom({ game, seed, roomId });
      return json({ ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const cluster = readCluster(url.searchParams.get('cluster') ?? '');
      const connection = connectionFor(cluster);
      const [slot, balance] = await Promise.all([
        connection.getSlot('confirmed'),
        connection.getBalance(WHITELIST_ADMIN, 'confirmed'),
      ]);
      return json({
        ok: true,
        cluster,
        rpc: CLUSTERS[cluster],
        slot,
        admin: WHITELIST_ADMIN.toBase58(),
        balanceLamports: balance,
        balanceSol: balance / LAMPORTS_PER_SOL,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/room') {
      const cluster = readCluster(url.searchParams.get('cluster') ?? '');
      const game = readGame(url.searchParams.get('game') ?? '');
      const seed = (url.searchParams.get('seed') ?? '').trim();
      const roomId = (url.searchParams.get('roomId') ?? '').trim();
      if (!seed && !roomId) throw new Error('Enter a room seed, or pick a room from the list.');
      const players = (url.searchParams.get('players') ?? '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      for (const player of players) {
        try {
          void new PublicKey(player);
        } catch {
          throw new Error(`Not a Solana address: ${player}`);
        }
      }
      const view = await inspectRoom(
        connectionFor(cluster),
        cluster,
        game,
        seed,
        players.map((player) => new PublicKey(player)),
        roomId,
        Number(url.searchParams.get('shoe') ?? '') || undefined,
        Number(url.searchParams.get('variant') ?? '') || undefined,
      );
      return json(view);
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await req.json() as Record<string, unknown>;
      return json(await plan(readPlan(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await req.json() as Record<string, unknown>;
      const cluster = readCluster(body.cluster);
      const steps = readSteps(body.steps);
      return json(await executeLocal(cluster, steps));
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await req.json() as Record<string, unknown>;
      const cluster = readCluster(body.cluster);
      if (typeof body.tx !== 'string' || typeof body.blockhash !== 'string') {
        throw new Error('Bad transaction.');
      }
      const height = Number(body.lastValidBlockHeight);
      if (!Number.isInteger(height)) throw new Error('Bad transaction.');
      const signature = await sendSigned(cluster, body.tx, body.blockhash, height);
      return json({ signature });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    return json({ error: explain(err) }, 400);
  }
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return api(req, url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (path.includes('..')) return new Response('Not found', { status: 404 });
    const file = Bun.file(join(PUBLIC, path));
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file);
  },
});

console.log(`admin http://127.0.0.1:${PORT}`);
