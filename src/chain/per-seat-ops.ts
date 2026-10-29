/**
 * Per-seat Solana op dispatcher — shared by WebView (in-process) and
 * `scripts/solana-player-cli.ts` (optional tooling).
 */
import { LOCALNET_RPC_URL } from './localnet-config';
import { isRpcReady } from './localnet-ready';
import {
  PerSeatClient,
  ensureSharedLocalnetRoom,
  fetchSharedTableSnapshot,
  parseSecretKey,
} from './per-seat-client';
import {
  beginSharedHand,
  placeBetPerSeat,
  expireBettingTurnPerSeat,
  registerHandKeyPerSeat,
  shuffleHandKeyPerSeat,
  shareHandKeyPerSeat,
  showdownHandKeyPerSeat,
  settleUncontestedFoldPerSeat,
  getShowdownMaterialsPerSeat,
  softCompleteShowdownPerSeat,
  advanceStreetPerSeat,
  fetchRevealedPartialsPerSeat,
  revealSealedPartialsPerSeat,
  prepareShowdownMaterialPerSeat,
  acknowledgeHolesPerSeat,
  startSharedBettingStreet,
  loadHandMeta,
} from './per-seat-hand';
import {
  isVersusCasinoGameKind,
  runCompleteCasinoHandPerSeat,
} from './per-seat-casino-hand';
import {
  enrichSnapshotFromChain,
  enrichSnapshotFromHandComplete,
} from './per-seat-chain-hand';
import { remoteSeatSigner } from './seat-signer';
import { getSharedMetaStore } from './shared-meta-store';
import { listTableCatalog, selectSharedTable } from './table-catalog';
import type { GameSnapshot } from '../backend/types';
import { isBackendGameKind, parseBackendGameKind } from '../backend/game-kind';

/**
 * Prefer on-chain hand enrichment; fall back to Complete meta.
 * Do NOT resurrect Register/Shuffle from stale shared-hand after endHand —
 * that skipped Complete in dual-native orch (Showdown → Register).
 */
async function enrichGameSnapshot(
  snap: GameSnapshot,
  rpcUrl: string,
): Promise<GameSnapshot> {
  const fromChain = await enrichSnapshotFromChain(snap, rpcUrl);
  if (fromChain) return attachGameKind(fromChain);

  // Pull hand-complete from `.local/` (WebView writes via solana.meta; CLI reads FS).
  await getSharedMetaStore().refreshFromDisk?.(['hand-complete']);
  const fromComplete = enrichSnapshotFromHandComplete(snap);
  if (fromComplete) return attachGameKind(fromComplete);

  return attachGameKind(snap);
}

function attachGameKind(snap: GameSnapshot): GameSnapshot {
  if (snap.gameKind) return snap;
  const meta = loadHandMeta();
  const kind = parseBackendGameKind(meta?.gameKind ?? process.env.E2E_GAME_KIND);
  if (!isBackendGameKind(kind)) return snap;
  return { ...snap, gameKind: kind };
}

export type PerSeatOpRequest = {
  op: string;
  seat?: number;
  publicKey?: string;
  secretKey?: number[] | string;
  chips?: string;
  amount?: string;
  action?: string;
  proof?: object;
  publicSignals?: string[];
  ciphertexts?: string[][][];
  /** Shuffled deck the prover returned. Verify uses it as the shuffle public shoe. */
  shuffledDeck?: string[][];
  showOnFold?: boolean;
  smallBlind?: string;
  recipientIndex?: number;
  cardIndices?: number[];
  contents?: string;
  winnerMasks?: Array<string | number>;
  bettingOnly?: boolean;
  players?: Array<{ secretKey: number[]; seat?: number; chips?: string }>;
  rpcUrl?: string;
  gameKind?: string;
  roomIdHex?: string;
  tableId?: string;
};

function requireSeatKey(raw: number[] | string | undefined, label: string): Uint8Array | undefined {
  if (raw !== undefined && raw !== null && !(Array.isArray(raw) && raw.length === 0) && raw !== '') {
    return parseSecretKey(raw);
  }
  if (remoteSeatSigner()) return undefined;
  throw new Error(`${label} requires a connected wallet`);
}

const PER_SEAT_READ_OPS = new Set([
  'snapshot',
  'getGame',
  'getDefaultGame',
]);

export async function executePerSeatOp(req: PerSeatOpRequest): Promise<object> {
  const rpcUrl = req.rpcUrl ?? LOCALNET_RPC_URL;

  if (req.op === 'health') {
    const ready = await isRpcReady(rpcUrl);
    return {
      ok: ready,
      worker: false,
      vitePreview: false,
      port: null,
      rpcUrl,
      localnetReady: ready,
      sessionReady: true,
      attachError: null,
      softBetting: false,
      bettingMode: 'arcium-mpc',
      perSeat: true,
      inProcess: true,
    };
  }
  if (req.op === 'listTableCatalog') {
    return listTableCatalog(rpcUrl);
  }
  if (req.op === 'selectTable') {
    if (!req.roomIdHex || req.tableId === undefined || req.tableId === '') {
      throw new Error('roomIdHex and tableId are required');
    }
    await selectSharedTable(req.roomIdHex, req.tableId, rpcUrl);
    const snap = await fetchSharedTableSnapshot(rpcUrl) as GameSnapshot;
    return enrichGameSnapshot(snap, rpcUrl);
  }
  if (req.op === 'ensureRoom' || req.op === 'ensureSharedRoom') {
    const forceFresh = (req as { forceFresh?: boolean }).forceFresh === true;
    return ensureSharedLocalnetRoom(rpcUrl, { forceFresh });
  }
  if (req.op === 'startHand' || req.op === 'start' || req.op === 'beginHand') {
    const bettingOnly = (typeof process !== 'undefined' && process.env?.PER_SEAT_BETTING_ONLY === '1')
      || req.bettingOnly === true;
    const gameKind = req.gameKind ?? (typeof process !== 'undefined' ? process.env.E2E_GAME_KIND : undefined);
    if (isVersusCasinoGameKind(gameKind) && !bettingOnly) {
      return runCompleteCasinoHandPerSeat({ rpcUrl, gameKind });
    }
    return beginSharedHand({
      rpcUrl,
      bettingOnly,
      gameKind,
      starterSecretKey: req.secretKey ? parseSecretKey(req.secretKey) : undefined,
      players: req.players?.map((p) => ({
        secretKey: parseSecretKey(p.secretKey),
        seat: p.seat,
        chips: p.chips !== undefined ? BigInt(p.chips) : undefined,
      })),
    });
  }
  if (req.op === 'runCompleteCasinoHand') {
    return runCompleteCasinoHandPerSeat({
      rpcUrl,
      gameKind: req.gameKind ?? (typeof process !== 'undefined' ? process.env.E2E_GAME_KIND : undefined),
    });
  }
  if (req.op === 'startBettingStreet') {
    return startSharedBettingStreet({
      rpcUrl,
      phase: (req.action as 'PreFlop' | 'Flop' | 'Turn' | 'River' | undefined) ?? 'PreFlop',
    });
  }
  if (PER_SEAT_READ_OPS.has(req.op) && !req.secretKey) {
    const snap = await fetchSharedTableSnapshot(rpcUrl) as GameSnapshot;
    // Must include zk + playerIndexBySeat or the UI never enters registerProve.
    return enrichGameSnapshot(snap, rpcUrl);
  }
  if (req.op === 'register' || req.op === 'registerHandKey') {
    if (!req.proof || !req.publicSignals) {
      throw new Error('proof + publicSignals required for register');
    }
    return registerHandKeyPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'register'),
      proof: req.proof,
      publicSignals: req.publicSignals,
      rpcUrl,
    });
  }
  if (req.op === 'shuffle' || req.op === 'submitShuffle') {
    if (!req.proof || !req.publicSignals) {
      throw new Error('proof + publicSignals required for shuffle');
    }
    return shuffleHandKeyPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'shuffle'),
      proof: req.proof,
      publicSignals: req.publicSignals,
      shuffledDeck: req.shuffledDeck,
      rpcUrl,
    });
  }
  if (req.op === 'share' || req.op === 'submitShare') {
    if (!req.proof || !req.publicSignals || !req.ciphertexts) {
      throw new Error('proof + publicSignals + ciphertexts required for share');
    }
    return shareHandKeyPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'share'),
      proof: req.proof,
      publicSignals: req.publicSignals,
      ciphertexts: req.ciphertexts,
      rpcUrl,
    });
  }
  if (req.op === 'showdownMaterials' || req.op === 'getShowdownMaterials') {
    return getShowdownMaterialsPerSeat({
      seat: req.seat,
      secretKey: requireSeatKey(req.secretKey, 'showdown materials'),
      rpcUrl,
    });
  }
  if (req.op === 'settleFold' || req.op === 'settleUncontestedFold') {
    return settleUncontestedFoldPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'settleFold'),
      rpcUrl,
    });
  }
  if (req.op === 'showdown' || req.op === 'submitShowdown') {
    if (!req.proof || !req.publicSignals) {
      throw new Error('proof + publicSignals required for showdown');
    }
    return showdownHandKeyPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'showdown'),
      proof: req.proof,
      publicSignals: req.publicSignals,
      winnerMasks: req.winnerMasks,
      rpcUrl,
    });
  }
  if (req.op === 'softComplete' || req.op === 'softCompleteShowdown') {
    // Throws unless ALLOW_SOFT_SHOWDOWN=1 — normal path waits for showdown prove.
    return softCompleteShowdownPerSeat({
      secretKey: req.secretKey ? parseSecretKey(req.secretKey) : undefined,
      rpcUrl,
    });
  }
  if (req.op === 'advance' || req.op === 'advanceStreet') {
    return advanceStreetPerSeat({
      rpcUrl,
      fromPhase: req.action as 'PreFlop' | 'Flop' | 'Turn' | 'River' | undefined,
    });
  }
  if (req.op === 'ackHoles' || req.op === 'acknowledgeHoleCards') {
    return acknowledgeHolesPerSeat({ rpcUrl });
  }
  if (req.op === 'revealedPartials' || req.op === 'fetchRevealedPartials') {
    return fetchRevealedPartialsPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'fetchRevealedPartials'),
      seat: req.seat,
      rpcUrl,
    });
  }
  if (req.op === 'revealSealedPartials') {
    const recipientIndex = req.recipientIndex ?? 0;
    const cardIndices = req.cardIndices ?? [];
    return revealSealedPartialsPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'reveal'),
      recipientIndex,
      cardIndices,
      rpcUrl,
    });
  }
  if (req.op === 'prepareShowdownMaterial') {
    return prepareShowdownMaterialPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'prepareShowdownMaterial'),
      seat: req.seat,
      rpcUrl,
    });
  }
  if (req.op === 'expireBetTurn') {
    return expireBettingTurnPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'expireBetTurn'),
      rpcUrl,
    });
  }
  if (req.op === 'action' || req.op === 'placeBet') {
    if (!req.action) throw new Error('action required');
    return placeBetPerSeat({
      secretKey: requireSeatKey(req.secretKey, 'placeBet'),
      action: req.action,
      amount: req.amount !== undefined ? BigInt(req.amount) : undefined,
      showOnFold: req.showOnFold,
      rpcUrl,
    });
  }
  const client = await PerSeatClient.create(
    requireSeatKey(req.secretKey, req.op),
    rpcUrl,
  );
  switch (req.op) {
    case 'join':
    case 'joinGame': {
      if (req.seat === undefined) throw new Error('seat required');
      const chips = req.chips !== undefined ? BigInt(req.chips) : undefined;
      return client.join(req.seat, chips);
    }
    case 'stand':
    case 'standUp':
      return client.stand();
    case 'sitOut':
      return client.sitOut();
    case 'faucet':
    case 'faucetCreditPersonal': {
      if (!req.amount) throw new Error('amount required');
      return client.faucet(BigInt(req.amount));
    }
    case 'transferToSeat':
    case 'transferPersonalToSeat': {
      if (!req.amount) throw new Error('amount required');
      return client.transferToSeat(BigInt(req.amount));
    }
    case 'transferToPersonal':
    case 'transferSeatToPersonal': {
      if (!req.amount) throw new Error('amount required');
      return client.transferToPersonal(BigInt(req.amount));
    }
    case 'snapshot':
    case 'getGame':
    case 'getDefaultGame': {
      const snap = await client.snapshot() as GameSnapshot;
      return enrichGameSnapshot(snap, rpcUrl);
    }
    default:
      throw new Error(`Unhandled per-seat op: ${req.op}`);
  }
}
