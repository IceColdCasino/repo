/**
 * On-chain player-action events from the poker program.
 *
 * Clients subscribe via Solana `connection.onLogs(programId)` and decode
 * `Program data:` log lines — no HTTP game API required to learn whose turn it is.
 *
 * Discriminators are Anchor `sha256("event:Name")[0..8]` (precomputed; browser-safe).
 */
import { Connection, PublicKey } from '@solana/web3.js';

/** Poker program id. Avoid importing localnet-config (process.env) in the browser. */
const DEFAULT_CASINO_PROGRAM_ID = '4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY';

/** Mirrors rust `ACTION_KIND_*`. */
export const ActionKind = {
  Register: 0,
  Shuffle: 1,
  Share: 2,
  Bet: 3,
  Showdown: 4,
  Reveal: 5,
} as const;

export type ActionKindId = (typeof ActionKind)[keyof typeof ActionKind];

export const ACTION_KIND_LABEL: Record<ActionKindId, string> = {
  [ActionKind.Register]: 'register',
  [ActionKind.Shuffle]: 'shuffle',
  [ActionKind.Share]: 'share',
  [ActionKind.Bet]: 'bet',
  [ActionKind.Showdown]: 'showdown',
  [ActionKind.Reveal]: 'reveal',
};

export interface PlayerActionRequired {
  gameId: Uint8Array;
  playerIndex: number;
  actionKind: ActionKindId;
  phase: number;
  bettingPhase: number;
}

export interface HandStartedEvent {
  gameId: Uint8Array;
  numPlayers: number;
}

export interface PhaseAdvancedEvent {
  gameId: Uint8Array;
  phase: number;
  bettingPhase: number;
  currentPlayer: number;
}

/** Emitted when a betting street closes after a bet callback. */
export interface StreetAdvancedEvent {
  gameId: Uint8Array;
  fromBettingPhase: number;
  bettingPhase: number;
  phase: number;
  currentPlayer: number;
}

export interface EscrowFundedEvent {
  player: PublicKey;
  personalDelta: bigint;
  seatDelta: bigint;
  kind: number;
}

/** Emitted after a validated bet/check/call/fold callback. */
export interface BetEvent {
  playerIndex: number;
  /** 0=fold,1=check,2=call,3=bet,4=raise,5=all-in (mirrors ACTION_MAP). */
  action: number;
  /** Chips added to the pot by this action (bet delta). */
  amount: bigint;
  isFold: boolean;
  isAllIn: boolean;
  showOnFold: boolean;
}

/** sha256("event:PlayerActionRequired")[0..8] */
export const PLAYER_ACTION_REQUIRED_DISC = Uint8Array.from([
  109, 116, 128, 238, 68, 108, 134, 23,
]);
/** sha256("event:HandStartedEvent")[0..8] */
export const HAND_STARTED_DISC = Uint8Array.from([
  200, 86, 169, 251, 243, 151, 99, 204,
]);
/** sha256("event:PhaseAdvancedEvent")[0..8] */
export const PHASE_ADVANCED_DISC = Uint8Array.from([
  126, 78, 165, 90, 186, 12, 223, 21,
]);
/** sha256("event:StreetAdvancedEvent")[0..8] */
export const STREET_ADVANCED_DISC = Uint8Array.from([
  88, 170, 69, 83, 46, 47, 165, 137,
]);
/** sha256("event:EscrowFundedEvent")[0..8] */
export const ESCROW_FUNDED_DISC = Uint8Array.from([
  65, 70, 171, 147, 6, 99, 166, 72,
]);
/** sha256("event:BetEvent")[0..8] */
export const BET_EVENT_DISC = Uint8Array.from([
  123, 52, 73, 185, 152, 169, 40, 128,
]);

function discEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < 8 || b.length < 8) {
    return false;
  }
  for (let i = 0; i < 8; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Decode a single Anchor event payload (discriminator + body). */
export function decodeAnchorEventPayload(raw: Uint8Array): {
  playerAction?: PlayerActionRequired;
  handStarted?: HandStartedEvent;
  phaseAdvanced?: PhaseAdvancedEvent;
  streetAdvanced?: StreetAdvancedEvent;
  escrowFunded?: EscrowFundedEvent;
  bet?: BetEvent;
} | null {
  if (raw.length < 8) {
    return null;
  }
  const disc = raw.subarray(0, 8);
  const body = raw.subarray(8);

  if (discEquals(disc, PLAYER_ACTION_REQUIRED_DISC)) {
    // game_id[32] + player_index u8 + action_kind u8 + phase u8 + betting_phase u8
    if (body.length < 36) {
      return null;
    }
    return {
      playerAction: {
        gameId: body.subarray(0, 32),
        playerIndex: body[32]!,
        actionKind: body[33]! as ActionKindId,
        phase: body[34]!,
        bettingPhase: body[35]!,
      },
    };
  }

  if (discEquals(disc, HAND_STARTED_DISC)) {
    if (body.length < 33) {
      return null;
    }
    return {
      handStarted: {
        gameId: body.subarray(0, 32),
        numPlayers: body[32]!,
      },
    };
  }

  if (discEquals(disc, PHASE_ADVANCED_DISC)) {
    if (body.length < 35) {
      return null;
    }
    return {
      phaseAdvanced: {
        gameId: body.subarray(0, 32),
        phase: body[32]!,
        bettingPhase: body[33]!,
        currentPlayer: body[34]!,
      },
    };
  }

  if (discEquals(disc, STREET_ADVANCED_DISC)) {
    // game_id[32] + from_betting_phase + betting_phase + phase + current_player
    if (body.length < 36) {
      return null;
    }
    const streetAdvanced: StreetAdvancedEvent = {
      gameId: body.subarray(0, 32),
      fromBettingPhase: body[32]!,
      bettingPhase: body[33]!,
      phase: body[34]!,
      currentPlayer: body[35]!,
    };
    // Also surface as PhaseAdvanced so existing snapshot apply paths advance UI.
    return {
      streetAdvanced,
      phaseAdvanced: {
        gameId: streetAdvanced.gameId,
        phase: streetAdvanced.phase,
        bettingPhase: streetAdvanced.bettingPhase,
        currentPlayer: streetAdvanced.currentPlayer,
      },
    };
  }

  if (discEquals(disc, BET_EVENT_DISC)) {
    // player_index u8 + action u8 + amount u64 + is_fold + is_all_in + show_on_fold
    if (body.length < 13) {
      return null;
    }
    return {
      bet: {
        playerIndex: body[0]!,
        action: body[1]!,
        amount: readU64LE(body, 2),
        isFold: body[10] !== 0,
        isAllIn: body[11] !== 0,
        showOnFold: body[12] !== 0,
      },
    };
  }

  if (discEquals(disc, ESCROW_FUNDED_DISC)) {
    // pubkey[32] + personal_delta u64 + seat_delta u64 + kind u8
    if (body.length < 49) {
      return null;
    }
    return {
      escrowFunded: {
        player: new PublicKey(body.subarray(0, 32)),
        personalDelta: readU64LE(body, 32),
        seatDelta: readU64LE(body, 40),
        kind: body[48]!,
      },
    };
  }

  return null;
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

/** Parse Anchor event base64 lines from transaction logs. */
export function parseEventsFromLogs(logs: readonly string[]): Array<NonNullable<
  ReturnType<typeof decodeAnchorEventPayload>
>> {
  const out: Array<NonNullable<ReturnType<typeof decodeAnchorEventPayload>>> = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) {
      continue;
    }
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    try {
      const raw = base64ToBytes(b64);
      const decoded = decodeAnchorEventPayload(raw);
      if (decoded) {
        out.push(decoded);
      }
    } catch {
      // ignore malformed log lines
    }
  }
  return out;
}

export function actionKindToBettingPhaseLabel(
  actionKind: ActionKindId,
  bettingPhase: number,
  phase: number,
): import('../backend/types').BettingPhase | 'lobby' {
  if (actionKind === ActionKind.Bet) {
    switch (bettingPhase) {
      case 1:
        return 'PreFlop';
      case 2:
        return 'Flop';
      case 3:
        return 'Turn';
      case 4:
        return 'River';
      default:
        return 'PreFlop';
    }
  }
  if (actionKind === ActionKind.Register) {
    return 'Register';
  }
  if (actionKind === ActionKind.Shuffle) {
    return 'Shuffle';
  }
  if (actionKind === ActionKind.Share) {
    return 'Share';
  }
  if (actionKind === ActionKind.Showdown || phase === 5 || bettingPhase === 5) {
    return 'Showdown';
  }
  // phase=3 Evaluation with no betting yet → PreFlop (hole-ack / blinds), not Showdown.
  if (phase === 3 && (bettingPhase === 0 || bettingPhase === undefined)) {
    return 'PreFlop';
  }
  return 'lobby';
}

export type PlayerActionHandler = (event: PlayerActionRequired, signature: string) => void;

export type DecodedPokerProgramEvent = NonNullable<ReturnType<typeof decodeAnchorEventPayload>>;

export type PokerProgramEventHandler = (
  event: DecodedPokerProgramEvent,
  signature: string,
) => void;

export type PokerProgramEventBatchHandler = (
  events: DecodedPokerProgramEvent[],
  signature: string,
) => void;

/** Matches on-chain `GameState.phase` / `PROOF_PHASE_*` (not off-by-one Idle). */
const ON_CHAIN_PHASE_LABEL: Record<number, string> = {
  0: 'Register',
  1: 'Shuffle',
  2: 'Share',
  3: 'Evaluation',
  4: 'Complete',
  5: 'Showdown',
  6: 'PotsDistributed',
};

const ON_CHAIN_BETTING_LABEL: Record<number, string> = {
  0: 'none',
  1: 'PreFlop',
  2: 'Flop',
  3: 'Turn',
  4: 'River',
};

/** Human-readable line for the UI Event log / orchestrator stdout. */
export function formatSolanaChainEvent(
  event: DecodedPokerProgramEvent,
  signature?: string,
): string {
  const sig = signature && signature.length > 0
    ? ` sig=${signature.slice(0, 8)}…`
    : '';
  if (event.playerAction) {
    const a = event.playerAction;
    const kind = ACTION_KIND_LABEL[a.actionKind] ?? `kind:${a.actionKind}`;
    const phase = ON_CHAIN_PHASE_LABEL[a.phase] ?? `phase:${a.phase}`;
    const betting = ON_CHAIN_BETTING_LABEL[a.bettingPhase] ?? `bet:${a.bettingPhase}`;
    return `Solana PlayerActionRequired: p${a.playerIndex} → ${kind} (${phase}/${betting})${sig}`;
  }
  if (event.handStarted) {
    return `Solana HandStartedEvent: ${event.handStarted.numPlayers} players${sig}`;
  }
  if (event.streetAdvanced) {
    const s = event.streetAdvanced;
    const from = ON_CHAIN_BETTING_LABEL[s.fromBettingPhase]
      ?? (s.fromBettingPhase === 5 ? 'Showdown' : `bet:${s.fromBettingPhase}`);
    const to = ON_CHAIN_BETTING_LABEL[s.bettingPhase]
      ?? (s.bettingPhase === 5 ? 'Showdown' : `bet:${s.bettingPhase}`);
    return `Solana StreetAdvancedEvent: ${from}→${to} currentPlayer=p${s.currentPlayer}${sig}`;
  }
  if (event.phaseAdvanced) {
    const p = event.phaseAdvanced;
    const phase = ON_CHAIN_PHASE_LABEL[p.phase] ?? `phase:${p.phase}`;
    const betting = ON_CHAIN_BETTING_LABEL[p.bettingPhase]
      ?? (p.bettingPhase === 5 ? 'Showdown' : `bet:${p.bettingPhase}`);
    return `Solana PhaseAdvancedEvent: ${phase}/${betting} currentPlayer=p${p.currentPlayer}${sig}`;
  }
  if (event.bet) {
    const b = event.bet;
    const ACTION_LABEL = ['fold', 'check', 'call', 'bet', 'raise', 'all-in'];
    const label = ACTION_LABEL[b.action] ?? `action:${b.action}`;
    const suffix = b.isFold ? ' (fold)' : b.amount > 0n ? ` +${b.amount}` : '';
    return `Solana BetEvent: p${b.playerIndex} ${label}${suffix}${sig}`;
  }
  if (event.escrowFunded) {
    const e = event.escrowFunded;
    const who = `${e.player.toBase58().slice(0, 8)}…`;
    // kind 0 = faucet → personal; 1 = personal→seat; 2 = seat→personal
    if (e.kind === 0 && e.personalDelta > 0n) {
      return `Faucet received: +${e.personalDelta} → personal escrow (${who})${sig}`;
    }
    return `Solana EscrowFundedEvent: ${who} personalΔ=${e.personalDelta} seatΔ=${e.seatDelta} kind=${e.kind}${sig}`;
  }
  return `Solana event (unknown)${sig}`;
}

/**
 * Subscribe to all decoded poker program Anchor events (not only PlayerActionRequired).
 */
export function subscribePokerProgramEvents(
  connection: Connection,
  onEvent: PokerProgramEventHandler,
  opts?: {
    programId?: string;
    commitment?: 'processed' | 'confirmed' | 'finalized';
    onBatch?: PokerProgramEventBatchHandler;
  },
): () => void {
  const programId = new PublicKey(opts?.programId ?? DEFAULT_CASINO_PROGRAM_ID);
  const subId = connection.onLogs(
    programId,
    (logInfo) => {
      const events = parseEventsFromLogs(logInfo.logs);
      if (opts?.onBatch) {
        opts.onBatch(events, logInfo.signature);
        return;
      }
      for (const ev of events) {
        onEvent(ev, logInfo.signature);
      }
    },
    opts?.commitment ?? 'confirmed',
  );
  return () => {
    void connection.removeOnLogsListener(subId);
  };
}

/**
 * Subscribe to poker program logs and invoke `onAction` for each PlayerActionRequired.
 * Returns an unsubscribe function.
 */
export function subscribePlayerActions(
  connection: Connection,
  onAction: PlayerActionHandler,
  opts?: { programId?: string; commitment?: 'processed' | 'confirmed' | 'finalized' },
): () => void {
  return subscribePokerProgramEvents(
    connection,
    (ev, signature) => {
      if (ev.playerAction) {
        onAction(ev.playerAction, signature);
      }
    },
    opts,
  );
}
