#!/usr/bin/env bun
/**
 * Dev-only seat 0 ZK helper (Bun + rapidsnark). Not used in E2E — clients prove via native bridge.
 * Used only by ios-e2e-host-player.ts for manual debugging.
 */
import { join } from 'node:path';
import { Player } from '../../src/poker-player';
import { preloadCircuits, releaseLoadedProvers } from '../../src/circuit-manager';
import type { GameSnapshot } from '../../src/backend/types';
import { preferredShowdownSubmitterSeat } from '../../src/backend/hand-result';
import {
  ciphertextFromJson,
  ciphertextMatrixFromJson,
  type ZkShowdownMaterials,
} from '../../src/backend/zk-serialize';
import { padPublicKeysForShare, shareOthersForPlayer } from '../../src/share-common';

const REPO_ROOT = join(import.meta.dir, '../..');
const BASE = (process.env.E2E_API_BASE ?? 'http://127.0.0.1:3847').replace(/\/$/, '');
const GAME_ID = 'local-table';
const HOST_SEAT = 0;
const POLL_MS = 400;
const SEAT0_KEY_FILE = join(REPO_ROOT, 'app/e2e-workspaces/ios-mac-host-seat-0/seat0-hand-key.json');
const SEAT0_KEY_DIST = join(REPO_ROOT, 'app/frontend/dist/seat0-hand-key.json');
/** Shuffle prove is ~9.4s on iOS simulator (317ms witness + 9.1s Groth16); allow 60s headroom. */
const HEAVY_ZK_TIMEOUT_MS = Number(process.env.IOS_E2E_HEAVY_ZK_MS ?? 60_000);
const SHARE_ZK_TIMEOUT_MS = Number(process.env.IOS_E2E_SHARE_ZK_MS ?? 300_000);
const SHOWDOWN_WATCH_MS = Number(process.env.IOS_E2E_SHOWDOWN_WAIT_MS ?? 420_000);
const SHOWDOWN_PROVE_MS = Number(process.env.IOS_E2E_SHOWDOWN_ZK_MS ?? 180_000);
const SHOWDOWN_PREFERENCE_MS = Number(process.env.IOS_E2E_SHOWDOWN_PREFERENCE_MS ?? 5_000);
const LOG_PREFIX = process.env.E2E_HOST_ZK_LOG_PREFIX ?? '[host-zk]';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}?backend=local`);
  if (!res.ok) {
    throw new Error(`${path} failed: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function materialsToInputs(materials: ZkShowdownMaterials) {
  return {
    playerIndex: materials.playerIndex,
    publicKeys: padPublicKeysForShare(
      materials.elGamalPublicKeys.map((key) => [BigInt(key[0]), BigInt(key[1])] as [bigint, bigint]),
    ),
    potMasks: materials.potMasks.map((value) => BigInt(value)),
    ciphertextCards: materials.finalDeck.map((card) => ciphertextFromJson(card)),
    ciphertextPartials: ciphertextMatrixFromJson(materials.ciphertextPartials),
  };
}

async function preferredShowdownSubmitter(
  snapshot: GameSnapshot,
  player: Player,
): Promise<number | null> {
  const previewSeat = snapshot.seats.find((seat) => !seat.folded)?.seat;
  if (previewSeat === undefined) {
    return null;
  }
  const materials = await getJson<ZkShowdownMaterials>(
    `/api/games/${GAME_ID}/showdown-materials/${previewSeat}`,
  );
  const inputs = materialsToInputs(materials);
  const previewMasks = player.previewShowdownWinnerMasks(
    inputs.playerIndex,
    inputs.publicKeys,
    inputs.potMasks,
    inputs.ciphertextCards,
    inputs.ciphertextPartials,
  );
  const handNumPlayers =
    snapshot.zkCrypto?.handNumPlayers
    ?? snapshot.seats.filter((seat) => seat.playerIndex !== undefined).length;
  const actionOrder = snapshot.actionOrder ?? snapshot.seats.map((seat) => seat.seat);
  const potResults = snapshot.pots.flatMap((pot, potIndex) => {
    const mask = previewMasks[potIndex] ?? 0n;
    const winnerSeats = actionOrder.filter((_seat, playerIndex) =>
      playerIndex < handNumPlayers && Boolean(mask & (1n << BigInt(playerIndex))),
    );
    return winnerSeats.length > 0
      ? [{ potIndex, amount: pot.amount, winnerSeats }]
      : [];
  });
  return preferredShowdownSubmitterSeat(
    potResults,
    actionOrder,
    new Set(snapshot.zkShowdown?.submittedSeats ?? []),
  );
}

async function submitHostShowdownIfPreferred(
  player: Player,
  snapshot: GameSnapshot,
): Promise<GameSnapshot> {
  const submitter = await preferredShowdownSubmitter(snapshot, player);
  if (submitter !== HOST_SEAT) {
    return snapshot;
  }
  console.log(`${LOG_PREFIX} showdown prove (seat 0)`);
  releaseLoadedProvers(await preloadCircuits());
  const materials = await getJson<ZkShowdownMaterials>(
    `/api/games/${GAME_ID}/showdown-materials/${HOST_SEAT}`,
  );
  const inputs = materialsToInputs(materials);
  const { proof, publicSignals, winnerMasks } = await player.showdownProve(
    inputs.playerIndex,
    inputs.publicKeys,
    inputs.potMasks,
    inputs.ciphertextCards,
    inputs.ciphertextPartials,
  );
  return postJson<GameSnapshot>(`/api/games/${GAME_ID}/showdown`, {
    seat: HOST_SEAT,
    proof,
    publicSignals,
    winnerMasks: winnerMasks.map((value) => value.toString()),
  });
}

async function watchShowdownUntilComplete(player: Player): Promise<void> {
  console.log(`${LOG_PREFIX} waiting for Showdown or Complete`);
  let snapshot = await pollUntil(
    'Showdown',
    SHOWDOWN_WATCH_MS,
    (s) => s.phase === 'Showdown' || s.phase === 'Complete',
  );
  if (snapshot.phase === 'Complete') {
    console.log(`${LOG_PREFIX} hand already complete before showdown watch`);
    return;
  }

  const preferenceUntil = Date.now() + SHOWDOWN_PREFERENCE_MS;
  const deadline = Date.now() + SHOWDOWN_PROVE_MS;
  while (Date.now() < deadline) {
    snapshot = await getState();
    if (snapshot.phase === 'Complete') {
      console.log(`${LOG_PREFIX} hand complete`);
      return;
    }
    if (snapshot.phase !== 'Showdown') {
      await sleep(POLL_MS);
      continue;
    }
    const submitted = snapshot.zkShowdown?.submittedCount ?? 0;
    if (submitted >= 1) {
      console.log(`${LOG_PREFIX} showdown proof observed on server`);
      await pollUntil('Complete', SHOWDOWN_WATCH_MS, (s) => s.phase === 'Complete');
      return;
    }

    const submitter = await preferredShowdownSubmitter(snapshot, player);
    if (submitter === HOST_SEAT) {
      snapshot = await submitHostShowdownIfPreferred(player, snapshot);
      if (snapshot.phase === 'Complete') {
        console.log(`${LOG_PREFIX} seat 0 showdown completed hand`);
        return;
      }
    } else if (Date.now() >= preferenceUntil) {
      console.log(`${LOG_PREFIX} waiting for iOS showdown (preferred seat ${submitter ?? 'unknown'})`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${LOG_PREFIX} timed out waiting for showdown to complete`);
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}?backend=local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function getState(): Promise<GameSnapshot> {
  const retryUntil = Date.now() + 60_000;
  let lastErr: unknown;
  while (Date.now() < retryUntil) {
    try {
      const res = await fetch(`${BASE}/api/games/${GAME_ID}?backend=local`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return await res.json() as GameSnapshot;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      const transient =
        code === 'ConnectionRefused'
        || msg.includes('ConnectionRefused')
        || msg.includes('Unable to connect')
        || msg.includes('ECONNREFUSED');
      if (transient) {
        console.warn(`${LOG_PREFIX} server unreachable, retrying...`);
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  label: string,
  timeoutMs: number,
  predicate: (snapshot: GameSnapshot) => boolean,
): Promise<GameSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: GameSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await getState();
    if (predicate(last)) {
      return last;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label} timed out (phase=${last?.phase ?? 'unknown'})`);
}

function registeredKeys(snapshot: GameSnapshot) {
  return (snapshot.zk?.elGamalPublicKeys ?? [])
    .filter((key): key is [string, string] => key !== null)
    .map((key) => [BigInt(key[0]), BigInt(key[1])] as [bigint, bigint]);
}

function deckFromSnapshot(snapshot: GameSnapshot) {
  const deck = snapshot.zk?.currentDeck;
  if (!deck) {
    throw new Error('missing deck');
  }
  return deck.map((card) => ciphertextFromJson(card));
}

function shareDeckFromSnapshot(snapshot: GameSnapshot) {
  const deck = snapshot.zk?.shareDeck ?? snapshot.zk?.currentDeck;
  if (!deck) {
    throw new Error('missing share deck');
  }
  return deck.slice(0, 25).map((card) => ciphertextFromJson(card));
}

async function seatForPlayerIndex(snapshot: GameSnapshot, playerIndex: number): Promise<number> {
  const entry = Object.entries(snapshot.playerIndexBySeat ?? {}).find(([, idx]) => idx === playerIndex);
  if (!entry) {
    throw new Error(`no seat for player index ${playerIndex}`);
  }
  return Number(entry[0]);
}

async function writeSeat0HandKey(player: Player): Promise<void> {
  const payload = JSON.stringify({
    privateKey: player.elGamalPrivateKey.toString(),
    publicKey: player.publicKey.map((value) => value.toString()),
  });
  await Bun.write(SEAT0_KEY_FILE, payload);
  await Bun.write(SEAT0_KEY_DIST, payload);
  console.log(`${LOG_PREFIX} wrote seat 0 hand key for native desktop share (${SEAT0_KEY_FILE})`);
}

export async function runHostSeat0Zk(): Promise<void> {
  process.chdir(REPO_ROOT);

  console.log(`${LOG_PREFIX} waiting for Register`);
  let snapshot = await pollUntil('Register', 60_000, (s) => s.phase === 'Register');

  const circuits = await preloadCircuits();
  const player = new Player(circuits);
  await player.init();
  player.generateKey();

  const hostIndex = snapshot.playerIndexBySeat?.[HOST_SEAT];
  if (hostIndex === undefined) {
    throw new Error('no host player index');
  }
  snapshot = await getState();
  if (!snapshot.zk?.elGamalPublicKeys[hostIndex]) {
    console.log(`${LOG_PREFIX} register prove (seat 0)`);
    const { proof, publicSignals } = await player.registerProve();
    snapshot = await getState();
    if (!snapshot.zk?.elGamalPublicKeys[hostIndex]) {
      try {
        snapshot = await postJson<GameSnapshot>(`/api/games/${GAME_ID}/register`, {
          seat: HOST_SEAT,
          proof,
          publicSignals,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already registered')) {
          throw err;
        }
        console.log(`${LOG_PREFIX} seat 0 already registered, continuing`);
        snapshot = await getState();
      }
    } else {
      console.log(`${LOG_PREFIX} seat 0 registered during prove, skipping POST`);
    }
    await writeSeat0HandKey(player);
  } else {
    console.log(`${LOG_PREFIX} seat 0 already registered, skipping prove`);
    await writeSeat0HandKey(player);
  }

  console.log(`${LOG_PREFIX} waiting for both players registered → Shuffle`);
  snapshot = await pollUntil(
    'Shuffle (both registered)',
    HEAVY_ZK_TIMEOUT_MS,
    (s) => s.phase === 'Shuffle' && (s.zk?.registeredCount ?? 0) >= 2,
  );

  const shuffleOrder = snapshot.zk!.shuffleOrder;
  for (const playerIndex of shuffleOrder) {
    snapshot = await getState();
    if (snapshot.phase !== 'Shuffle') {
      break;
    }
    const seat = await seatForPlayerIndex(snapshot, playerIndex);
    const orderIndex = shuffleOrder.indexOf(playerIndex);
    if (seat !== HOST_SEAT) {
      await pollUntil(
        `shuffle player ${playerIndex} (seat ${seat})`,
        HEAVY_ZK_TIMEOUT_MS,
        (s) => {
          if (s.phase !== 'Shuffle') return true;
          const count = s.zk?.shuffledCount ?? 0;
          return count > orderIndex;
        },
      );
      continue;
    }
    console.log(`[mac-host-zk] shuffle prove (seat 0) — player index ${playerIndex}`);
    const deck = deckFromSnapshot(snapshot);
    const keys = registeredKeys(snapshot);
    const { proof, publicSignals } = await player.shuffleProve(deck as never, keys as never);
    try {
      snapshot = await postJson<GameSnapshot>(`/api/games/${GAME_ID}/shuffle`, {
        seat: HOST_SEAT,
        proof,
        publicSignals,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not your shuffle turn')) {
        snapshot = await getState();
        if ((snapshot.zk?.shuffledCount ?? 0) > orderIndex) {
          console.log(`${LOG_PREFIX} seat 0 shuffle already on chain, continuing`);
          continue;
        }
      }
      throw err;
    }
  }

  console.log(`${LOG_PREFIX} waiting for Share`);
  snapshot = await pollUntil('Share', SHARE_ZK_TIMEOUT_MS, (s) => s.phase === 'Share');

  if (process.env.E2E_HOST_ZK_STOP_AFTER === 'shuffle') {
    console.log(`${LOG_PREFIX} stop after shuffle — share/deal handled by native desktop + iOS apps`);
    await waitForShareCompleteAndShowdown(player);
    return;
  }

  await submitHostShareIfNeeded(player, snapshot);
  await waitForShareCompleteAndShowdown(player);
}

async function submitHostShareIfNeeded(player: Player, snapshot: GameSnapshot): Promise<void> {
  // Release shuffle/register zkey bytes + provers before share (~883MB zkey + witness buffers).
  releaseLoadedProvers(await preloadCircuits());

  const hostPlayerIndex = snapshot.playerIndexBySeat?.[HOST_SEAT];
  if (hostPlayerIndex === undefined) {
    throw new Error('no host player index in Share phase');
  }
  snapshot = await getState();
  if (snapshot.phase !== 'Share' || snapshot.zk?.hasSharedPartial?.[hostPlayerIndex] === true) {
    return;
  }
  console.log(`${LOG_PREFIX} share prove (seat 0, player index ${hostPlayerIndex})`);
  const shareDeck = shareDeckFromSnapshot(snapshot);
  const registered = snapshot.zk!.elGamalPublicKeys
    .filter((key): key is [string, string] => key !== null)
    .map((key) => [BigInt(key[0]), BigInt(key[1])] as [bigint, bigint]);
  const shareKeys = shareOthersForPlayer(registered, hostPlayerIndex);
  const { proof, publicSignals, ciphertexts } = await player.shareProve(
    shareDeck,
    shareKeys,
    registered.length,
  );
  const json = ciphertexts.map((row) =>
    row.map((cell) => cell.map((value) => value.toString())),
  );
  try {
    await postJson<GameSnapshot>(`/api/games/${GAME_ID}/share`, {
      seat: HOST_SEAT,
      proof,
      publicSignals,
      ciphertexts: json,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Partials already submitted')) {
      console.log(`${LOG_PREFIX} seat 0 share already on chain, continuing`);
      return;
    }
    throw err;
  }
}

async function waitForShareCompleteAndShowdown(player: Player): Promise<void> {
  console.log(`${LOG_PREFIX} waiting for both share partials`);
  let snapshot = await getState();
  const sharePlayerIndices = [...new Set(Object.values(snapshot.playerIndexBySeat ?? {}))].sort(
    (a, b) => a - b,
  );
  for (const playerIndex of sharePlayerIndices) {
    snapshot = await getState();
    if (snapshot.phase !== 'Share') {
      break;
    }
    if (snapshot.zk?.hasSharedPartial?.[playerIndex] === true) {
      continue;
    }
    const seat = await seatForPlayerIndex(snapshot, playerIndex);
    await pollUntil(
      `share player ${playerIndex} (seat ${seat})`,
      SHARE_ZK_TIMEOUT_MS,
      (s) => s.zk?.hasSharedPartial?.[playerIndex] === true || s.phase !== 'Share',
    );
  }

  console.log(`${LOG_PREFIX} waiting for PreFlop`);
  await pollUntil(
    'PreFlop',
    SHARE_ZK_TIMEOUT_MS,
    (s) => s.phase === 'PreFlop' && s.zkReveal?.shareComplete === true,
  );
  console.log(`${LOG_PREFIX} PreFlop reached — watching for showdown (seat 0 submits when preferred)`);
  await watchShowdownUntilComplete(player);
}

/** Poll until hand completes; native macOS + iOS clients drive all ZK (no Bun prove). */
export async function runHostShowdownWatchOnly(): Promise<void> {
  process.chdir(REPO_ROOT);
  console.log(`${LOG_PREFIX} watch-only: native desktop + iOS drive all ZK`);
  await pollUntil(
    'hand started',
    300_000,
    (s) => s.phase !== 'lobby' && (s.handNumber ?? 0) > 0,
  );
  await pollUntil(
    'Complete',
    SHOWDOWN_WATCH_MS + SHOWDOWN_PROVE_MS,
    (s) => s.phase === 'Complete' && Boolean(s.handResult),
  );
  const finalState = await getState();
  console.log(
    `${LOG_PREFIX} hand complete (phase=${finalState.phase}, pots=${finalState.handResult?.potResults?.length ?? 0})`,
  );
}

/** Fresh Bun process: load persisted seat-0 key and submit share (fallback if native desktop share stalls). */
export async function runHostSeat0ShareOnly(): Promise<void> {
  process.chdir(REPO_ROOT);
  const keyPath = SEAT0_KEY_FILE;
  if (!(await Bun.file(keyPath).exists())) {
    throw new Error(`missing seat 0 hand key at ${keyPath}`);
  }
  const parsed = JSON.parse(await Bun.file(keyPath).text()) as {
    privateKey: string;
    publicKey: [string, string];
  };
  const circuits = await preloadCircuits();
  const player = new Player(circuits);
  await player.init();
  player.loadPlayerKey({
    privateKey: BigInt(parsed.privateKey),
    publicKey: [BigInt(parsed.publicKey[0]), BigInt(parsed.publicKey[1])],
  });

  console.log(`${LOG_PREFIX} share-only: waiting for Share phase`);
  let snapshot = await pollUntil('Share', SHARE_ZK_TIMEOUT_MS, (s) => s.phase === 'Share');
  const hostPlayerIndex = snapshot.playerIndexBySeat?.[HOST_SEAT];
  if (hostPlayerIndex === undefined) {
    throw new Error('no host player index in Share phase');
  }
  snapshot = await getState();
  if (snapshot.zk?.hasSharedPartial?.[hostPlayerIndex] === true) {
    console.log(`${LOG_PREFIX} share-only: seat 0 partial already submitted`);
    return;
  }
  console.log(`${LOG_PREFIX} share-only: prove (seat 0, player index ${hostPlayerIndex})`);
  const shareDeck = shareDeckFromSnapshot(snapshot);
  const registered = snapshot.zk!.elGamalPublicKeys
    .filter((key): key is [string, string] => key !== null)
    .map((key) => [BigInt(key[0]), BigInt(key[1])] as [bigint, bigint]);
  const shareKeys = shareOthersForPlayer(registered, hostPlayerIndex);
  const { proof, publicSignals, ciphertexts } = await player.shareProve(
    shareDeck,
    shareKeys,
    registered.length,
  );
  const json = ciphertexts.map((row) =>
    row.map((cell) => cell.map((value) => value.toString())),
  );
  await postJson<GameSnapshot>(`/api/games/${GAME_ID}/share`, {
    seat: HOST_SEAT,
    proof,
    publicSignals,
    ciphertexts: json,
  });
  console.log(`${LOG_PREFIX} share-only: seat 0 share submitted`);
}

if (import.meta.main) {
  const startAt = process.env.E2E_HOST_ZK_START_AT;
  const runner = startAt === 'showdown-watch'
    ? runHostShowdownWatchOnly
    : startAt === 'share'
      ? runHostSeat0ShareOnly
      : runHostSeat0Zk;
  runner().catch((err) => {
    console.error(`${LOG_PREFIX} fatal:`, err);
    process.exit(1);
  });
}
