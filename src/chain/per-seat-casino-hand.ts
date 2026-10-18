/**
 * Host / macOS startHand path for War and Baccarat: run ContinuousCasinoHand
 * (Groth16 + Arcis) in Bun, then publish hand-complete so the native table
 * can show Complete + versus-dealer faces. Shuffle must not run in WKWebView.
 */
import { Connection } from '@solana/web3.js';
import type { GameSnapshot } from '../backend/types';
import { buildCasinoHandResult, type VersusCasinoKind } from '../backend/casino-hand-result';
import { parseBackendGameKind } from '../backend/game-kind';
import { loadWhitelistAdminProvider } from './admin-provider';
import { ContinuousCasinoHand } from './continuous-casino-hand';
import { createContinuousHand, loadCircuitsForGame } from './continuous-hand-factory';
import { LOCALNET_RPC_URL } from './localnet-config';
import {
  clearHandCompleteMeta,
  enrichSnapshotFromHandComplete,
  saveHandCompleteMeta,
} from './per-seat-chain-hand';
import {
  ensureSharedLocalnetRoom,
  fetchSharedTableSnapshot,
  LOCALNET_SHARED_ROOM_SEED,
} from './per-seat-client';
import { loadCasinoProgram, loadLightCasinoProgram } from './program-loader';
import { getSharedMetaStore, readSharedMeta, writeSharedMeta } from './shared-meta-store';

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function isVersusCasinoKind(value: string): value is VersusCasinoKind {
  return value === 'war' || value === 'baccarat';
}

export function isVersusCasinoGameKind(value: unknown): value is VersusCasinoKind {
  const kind = parseBackendGameKind(value);
  return isVersusCasinoKind(kind);
}

export async function runCompleteCasinoHandPerSeat(opts?: {
  gameKind?: string | number;
  rpcUrl?: string;
}): Promise<GameSnapshot> {
  const rpcUrl = opts?.rpcUrl ?? LOCALNET_RPC_URL;
  const kind = parseBackendGameKind(opts?.gameKind);
  if (!isVersusCasinoKind(kind)) {
    throw new Error(`runCompleteCasinoHandPerSeat supports war/baccarat, got ${kind}`);
  }

  const tableMeta = await ensureSharedLocalnetRoom(rpcUrl);
  const connection = new Connection(rpcUrl, 'confirmed');
  const admin = await loadWhitelistAdminProvider(connection);
  const pokerProgram = loadCasinoProgram(admin);
  const lightPokerProgram = loadLightCasinoProgram(admin);
  const circuits = await loadCircuitsForGame(kind);
  const hand = createContinuousHand({
    kind,
    circuits,
    pokerProgram,
    lightPokerProgram,
    provider: admin,
    numPlayers: 2,
  });
  if (!(hand instanceof ContinuousCasinoHand)) {
    throw new Error(`Continuous hand for ${kind} is not ContinuousCasinoHand`);
  }

  clearHandCompleteMeta();
  const gameIdHex = bytesToHex(hand.gameId);
  writeSharedMeta(
    'shared-hand',
    JSON.stringify({
      gameIdHex,
      tableId: String(tableMeta.tableId),
      roomSeed: tableMeta.roomSeed ?? LOCALNET_SHARED_ROOM_SEED,
      numPlayers: 2,
      playerPubkeys: [],
      physicalSeats: [0, 1],
      tableKey: {
        publicKey: Array.from(hand.tableKey.publicKey),
        nonceBase: hand.tableKey.nonceBase.toString(),
      },
      registeredMask: 0,
      bettingOnly: false,
      gameKind: kind,
    }, null, 2),
  );
  await getSharedMetaStore().flushWrites?.();

  console.log(`[per-seat] ${kind} Arcis hand starting gameId=${gameIdHex}`);
  const result = await hand.runCompleteHand();
  const plaintextCards = result.plaintextCards ?? [];
  const handResult = buildCasinoHandResult({
    kind,
    winner: result.winner,
    plaintextCards,
    potAmount: 200n,
  });
  saveHandCompleteMeta({
    tableId: String(tableMeta.tableId),
    gameIdHex,
    gameKind: kind,
    handResult,
  });
  await getSharedMetaStore().flushWrites?.();
  console.log(
    `[per-seat] ${kind} Arcis hand complete winner=${result.winner} cards=${plaintextCards.join(',')}`,
  );

  const snap = await fetchSharedTableSnapshot(rpcUrl);
  const complete = enrichSnapshotFromHandComplete({ ...snap, gameKind: kind });
  if (complete) {
    return complete;
  }
  return {
    ...snap,
    gameKind: kind,
    phase: 'Complete',
    handResult,
    boardCards: handResult.boardCards,
    holeCards: Object.fromEntries(
      handResult.seatHands.map((seatHand) => [seatHand.seat, seatHand.holeCards]),
    ),
  };
}

export function peekSharedCasinoKind(): VersusCasinoKind | null {
  try {
    const raw = readSharedMeta('shared-hand');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { gameKind?: string };
    const kind = parsed.gameKind ?? '';
    return isVersusCasinoKind(kind) ? kind : null;
  } catch {
    return null;
  }
}
