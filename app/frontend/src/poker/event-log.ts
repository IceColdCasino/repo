import { potResultsFromHandResult } from '@poker-src/backend/hand-result';
import type { GameSnapshot, SeatSnapshot } from '../backend/client';

export type HandEventKind =
  | 'phase'
  | 'zk'
  | 'action'
  | 'reveal'
  | 'result'
  | 'error'
  | 'info'
  | 'chain';

export interface HandEventLogEntry {
  id: string;
  at: number;
  handNumber: number | null;
  kind: HandEventKind;
  message: string;
}

const MAX_LOG_ENTRIES = 200;

let nextEventSeq = 0;

export function createHandEvent(
  kind: HandEventKind,
  message: string,
  handNumber: number | null = null,
  at: number = Date.now(),
): HandEventLogEntry {
  nextEventSeq += 1;
  return {
    id: `${at}-${nextEventSeq}`,
    at,
    handNumber,
    kind,
    message,
  };
}

/** Phase / reveal / ZK milestone lines are unique per hand; actions may repeat by street. */
function isOncePerHandEvent(event: HandEventLogEntry): boolean {
  if (event.kind === 'reveal' || event.kind === 'phase') {
    return true;
  }
  if (event.kind === 'zk') {
    return true;
  }
  if (event.kind === 'chain') {
    return true;
  }
  return /prove starting/i.test(event.message);
}

export function shouldAppendHandEvent(
  log: HandEventLogEntry[],
  event: HandEventLogEntry,
): boolean {
  const last = log[log.length - 1];
  if (last && last.kind === event.kind && last.message === event.message) {
    return false;
  }
  if (
    isOncePerHandEvent(event)
    && log.some((entry) => entry.kind === event.kind && entry.message === event.message)
  ) {
    return false;
  }
  return true;
}

export function appendHandEvents(
  log: HandEventLogEntry[],
  events: HandEventLogEntry[],
): HandEventLogEntry[] {
  if (events.length === 0) {
    return log;
  }
  const next = [...log];
  for (const event of events) {
    if (shouldAppendHandEvent(next, event)) {
      next.push(event);
    }
  }
  return next.slice(-MAX_LOG_ENTRIES);
}

function seatByNumber(seats: SeatSnapshot[], seat: number): SeatSnapshot | undefined {
  return seats.find((entry) => entry.seat === seat);
}

function seatForPlayerIndex(snapshot: GameSnapshot, playerIndex: number): number | null {
  const fromOrder = snapshot.actionOrder?.[playerIndex];
  if (typeof fromOrder === 'number') {
    return fromOrder;
  }
  const entry = Object.entries(snapshot.playerIndexBySeat ?? {}).find(
    ([, idx]) => idx === playerIndex,
  );
  return entry ? Number(entry[0]) : null;
}

function formatPhase(phase: GameSnapshot['phase']): string {
  return phase;
}

function zkMilestoneEvents(
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number,
): HandEventLogEntry[] {
  const events: HandEventLogEntry[] = [];
  const handNumber = next.handNumber ?? null;
  const prevZk = prev?.zk;
  const zk = next.zk;
  const prevSd = prev?.zkShowdown;
  const sd = next.zkShowdown;
  if (
    next.phase === 'Showdown'
    && sd?.requested
    && (sd.submittedCount ?? 0) === 0
    && prev?.phase !== 'Showdown'
  ) {
    events.push(createHandEvent(
      'zk',
      'Showdown requested — awaiting proof',
      handNumber,
      at,
    ));
  }
  if (sd && (prevSd?.submittedCount ?? 0) < sd.submittedCount) {
    events.push(createHandEvent(
      'zk',
      `Showdown submitted (${sd.submittedCount}/${sd.requiredCount})`,
      handNumber,
      at,
    ));
  }
  if (!zk) {
    return events;
  }

  if ((prevZk?.registeredCount ?? 0) < zk.registeredCount) {
    for (let i = prevZk?.registeredCount ?? 0; i < zk.registeredCount; i += 1) {
      const seat = seatForPlayerIndex(next, i);
      const total = zk.elGamalPublicKeys.length || zk.registeredCount;
      const who = seat !== null ? `Seat ${seat}` : `Player ${i}`;
      events.push(createHandEvent(
        'zk',
        `${who} registered (${i + 1}/${total})`,
        handNumber,
        at,
      ));
    }
  }

  if ((prevZk?.shuffledCount ?? 0) < zk.shuffledCount) {
    for (let i = prevZk?.shuffledCount ?? 0; i < zk.shuffledCount; i += 1) {
      const seat = seatForPlayerIndex(next, i);
      const total = zk.registeredCount || zk.shuffledCount;
      const who = seat !== null ? `Seat ${seat}` : `Player ${i}`;
      events.push(createHandEvent(
        'zk',
        `${who} shuffled (${i + 1}/${total})`,
        handNumber,
        at,
      ));
    }
  }

  const prevPartials = prevZk?.hasSharedPartial ?? [];
  const nextPartials = zk.hasSharedPartial ?? [];
  const required = zk.requiredShares ?? zk.registeredCount;
  for (let i = 0; i < nextPartials.length; i += 1) {
    if (nextPartials[i] === true && prevPartials[i] !== true) {
      const seat = seatForPlayerIndex(next, i);
      const who = seat !== null ? `Seat ${seat}` : `Player ${i}`;
      const done = nextPartials.filter(Boolean).length;
      events.push(createHandEvent(
        'zk',
        `${who} shared partials (${done}/${required})`,
        handNumber,
        at,
      ));
    }
  }

  if ((prevZk?.sharedCount ?? 0) < (zk.sharedCount ?? 0) && nextPartials.length === 0) {
    events.push(createHandEvent(
      'zk',
      `Share progress ${zk.sharedCount}/${required}`,
      handNumber,
      at,
    ));
  }

  return events;
}

/**
 * After every seat's share is in, emit any missing per-seat lines then a summary.
 * Parallel share: either seat may finish last; the completing publish must still
 * surface "Seat N shared partials" for every seat that flipped on this jump.
 */
function shareFinalizedEvents(
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number,
): HandEventLogEntry[] {
  if (
    prev?.phase !== 'Share'
    || (next.phase !== 'PreFlop' && next.zkReveal?.shareComplete !== true)
  ) {
    return [];
  }

  const events: HandEventLogEntry[] = [];
  const handNumber = next.handNumber ?? null;
  const prevPartials = prev.zk?.hasSharedPartial ?? [];
  const nextPartials = next.zk?.hasSharedPartial;
  const n = next.zk?.requiredShares
    ?? prev.zk?.requiredShares
    ?? Object.keys(next.playerIndexBySeat ?? prev.playerIndexBySeat ?? {}).length
    ?? next.actionOrder?.length
    ?? prev.actionOrder?.length
    ?? 2;

  // When PreFlop still carries finalizedShareZk, zkMilestoneEvents already logged
  // flips. If zk was dropped entirely, synthesize remaining seats here.
  if (!nextPartials || nextPartials.length === 0) {
    let done = prevPartials.filter(Boolean).length;
    for (let i = 0; i < n; i += 1) {
      if (prevPartials[i] === true) {
        continue;
      }
      done += 1;
      const seat = seatForPlayerIndex(prev, i) ?? seatForPlayerIndex(next, i);
      const who = seat !== null ? `Seat ${seat}` : `Player ${i}`;
      events.push(createHandEvent(
        'zk',
        `${who} shared partials (${done}/${n})`,
        handNumber,
        at,
      ));
    }
  }

  events.push(createHandEvent(
    'zk',
    `Share complete (${n}/${n}) — share finalized`,
    handNumber,
    at,
  ));
  return events;
}

const BETTING_PHASES = new Set(['PreFlop', 'Flop', 'Turn', 'River']);

/** Hand lifecycle ranks — Event log must not emit mid-hand backward phase lines. */
const PHASE_RANK: Record<string, number> = {
  lobby: 0,
  Register: 1,
  Shuffle: 2,
  Share: 3,
  PreFlop: 4,
  Flop: 5,
  Turn: 6,
  River: 7,
  Showdown: 8,
  Complete: 9,
};

function isForwardOrResetPhase(
  prev: GameSnapshot['phase'] | undefined,
  next: GameSnapshot['phase'],
  handCleared: boolean,
): boolean {
  if (handCleared || !prev || prev === 'lobby' || next === 'lobby') {
    return true;
  }
  if (next === 'Register' && (prev === 'Complete' || prev === 'Register')) {
    return true;
  }
  const prevRank = PHASE_RANK[prev];
  const nextRank = PHASE_RANK[next];
  if (prevRank === undefined || nextRank === undefined) {
    return true;
  }
  return nextRank >= prevRank;
}

function bettingActionEvents(
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number,
): HandEventLogEntry[] {
  if (!prev || prev.handNumber !== next.handNumber) {
    return [];
  }
  if (!BETTING_PHASES.has(next.phase) && !BETTING_PHASES.has(prev.phase)) {
    return [];
  }

  const events: HandEventLogEntry[] = [];
  const handNumber = next.handNumber ?? null;
  const prevBetTotal = BigInt(prev.currentBet || '0');

  for (const seat of next.seats) {
    const before = seatByNumber(prev.seats, seat.seat);
    if (!before) {
      continue;
    }
    if (!before.folded && seat.folded) {
      events.push(createHandEvent('action', `Seat ${seat.seat} folded`, handNumber, at));
      continue;
    }
    const prevChips = BigInt(before.bet || '0');
    const nextChips = BigInt(seat.bet || '0');
    if (nextChips <= prevChips) {
      continue;
    }
    if (nextChips === prevBetTotal && prevChips < prevBetTotal) {
      events.push(createHandEvent(
        'action',
        `Seat ${seat.seat} called ${nextChips - prevChips}`,
        handNumber,
        at,
      ));
    } else if (nextChips > prevBetTotal) {
      events.push(createHandEvent(
        'action',
        `Seat ${seat.seat} raised to ${nextChips}`,
        handNumber,
        at,
      ));
    } else {
      events.push(createHandEvent(
        'action',
        `Seat ${seat.seat} bet ${nextChips - prevChips}`,
        handNumber,
        at,
      ));
    }
  }

  // Checks: actor advanced with no bet/fold change.
  if (
    prev.bettingRoundOpen
    && prev.currentPlayerSeat !== null
    && next.currentPlayerSeat !== prev.currentPlayerSeat
    && BETTING_PHASES.has(prev.phase)
  ) {
    const actor = seatByNumber(prev.seats, prev.currentPlayerSeat);
    const after = actor ? seatByNumber(next.seats, actor.seat) : undefined;
    if (
      actor
      && after
      && !after.folded
      && BigInt(actor.bet || '0') === BigInt(after.bet || '0')
      && BigInt(actor.bet || '0') === prevBetTotal
    ) {
      const already = events.some((e) => e.message.startsWith(`Seat ${actor.seat} `));
      if (!already) {
        events.push(createHandEvent('action', `Seat ${actor.seat} checked`, handNumber, at));
      }
    }
  }

  return events;
}

function revealEvents(
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number,
): HandEventLogEntry[] {
  const events: HandEventLogEntry[] = [];
  const handNumber = next.handNumber ?? null;
  const prevIndices = new Set(prev?.zkReveal?.revealedCardIndices ?? []);
  const nextIndices = next.zkReveal?.revealedCardIndices ?? [];
  const newly = nextIndices.filter((idx) => !prevIndices.has(idx));
  if (newly.length > 0) {
    events.push(createHandEvent(
      'reveal',
      `Revealed deal cards: ${newly.join(', ')}`,
      handNumber,
      at,
    ));
  } else if ((next.zkReveal?.newlyRevealed?.length ?? 0) > 0 && prev?.phase !== next.phase) {
    events.push(createHandEvent(
      'reveal',
      `Revealed deal cards: ${next.zkReveal!.newlyRevealed.join(', ')}`,
      handNumber,
      at,
    ));
  }
  return events;
}

function seatsFromWinnerMask(mask: string | bigint): number[] {
  const seats: number[] = [];
  let bits = BigInt(mask);
  let seat = 0;
  while (bits > 0n && seat < 64) {
    if ((bits & 1n) === 1n) seats.push(seat);
    bits >>= 1n;
    seat += 1;
  }
  return seats;
}

function resultEvents(
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number,
): HandEventLogEntry[] {
  const events: HandEventLogEntry[] = [];
  const handNumber = next.handNumber ?? null;
  if (!prev?.handResult && next.handResult) {
    // Prefer proof winnerMasks (all set bits) over a single-seat heuristic.
    const masks = next.handResult.winnerMasks;
    const potResults = potResultsFromHandResult(next.handResult).map((pot) => {
      const raw = masks?.[pot.potIndex];
      if (raw === undefined) return pot;
      const seats = seatsFromWinnerMask(raw);
      return seats.length > 0 ? { ...pot, winnerSeats: seats } : pot;
    });
    const potLines = potResults.map((pot) => {
      const seats = pot.winnerSeats;
      if (seats.length === 0) {
        return `Pot ${pot.potIndex + 1}: ${pot.amount}`;
      }
      if (seats.length === 1) {
        return `Pot ${pot.potIndex + 1}: Seat ${seats[0]} wins ${pot.amount}`;
      }
      return `Pot ${pot.potIndex + 1}: Seat ${seats.join(' & Seat ')} split ${pot.amount}`;
    });
    const potText = potLines.length > 0 ? ` — ${potLines.join('; ')}` : '';
    events.push(createHandEvent(
      'result',
      `Hand complete (${next.handResult.reason})${potText}`,
      handNumber,
      at,
    ));
  } else if (prev?.phase !== 'Complete' && next.phase === 'Complete' && !next.handResult) {
    events.push(createHandEvent('result', 'Hand complete', handNumber, at));
  }
  return events;
}

/**
 * Diff two game snapshots into append-only UI log events.
 * When `handNumber` increases, returns `clear: true` so the caller starts a fresh hand section.
 */
export function eventsFromSnapshotDiff(
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number = Date.now(),
): { clear: boolean; events: HandEventLogEntry[] } {
  const handChanged =
    prev != null
    && next.handNumber != null
    && prev.handNumber != null
    && next.handNumber !== prev.handNumber;

  const clear = handChanged;
  const baseline = clear ? null : prev;
  const events: HandEventLogEntry[] = [];
  const handNumber = next.handNumber ?? null;
  // Opening a window onto a hand that is already over is not a new deal.
  const alreadyFinished = baseline == null && next.phase === 'Complete';

  if (
    !alreadyFinished
    && (clear || (baseline == null && next.handNumber != null && next.phase !== 'lobby'))
  ) {
    events.push(createHandEvent('info', `Hand ${next.handNumber} started`, handNumber, at));
  }

  if (!alreadyFinished && baseline?.phase !== next.phase && next.phase !== 'lobby') {
    if (!isForwardOrResetPhase(baseline?.phase, next.phase, clear)) {
      // Drop illegal mid-hand rollbacks (e.g. Shuffle → Register) from the UI log.
    } else if (baseline?.phase && baseline.phase !== 'lobby' && !clear) {
      events.push(createHandEvent(
        'phase',
        `${formatPhase(baseline.phase)} → ${formatPhase(next.phase)}`,
        handNumber,
        at,
      ));
    } else {
      events.push(createHandEvent(
        'phase',
        `Phase: ${formatPhase(next.phase)}`,
        handNumber,
        at,
      ));
    }
  }

  // Per-seat share events first (including Share→PreFlop where the completing
  // seat's hasSharedPartial flip used to be dropped when zkHand was nulled).
  if (!alreadyFinished) {
    events.push(...zkMilestoneEvents(baseline, next, at));
    events.push(...shareFinalizedEvents(baseline, next, at));
    events.push(...bettingActionEvents(baseline, next, at));
    events.push(...revealEvents(baseline, next, at));
  }
  events.push(...resultEvents(baseline, next, at));

  return { clear, events };
}

/** Apply a snapshot diff onto an existing log (handles hand boundaries). */
export function reduceHandEventLog(
  log: HandEventLogEntry[],
  prev: GameSnapshot | null,
  next: GameSnapshot,
  at: number = Date.now(),
): { log: HandEventLogEntry[]; prev: GameSnapshot } {
  const { clear, events } = eventsFromSnapshotDiff(prev, next, at);
  const base = clear ? [] : log;
  return {
    log: appendHandEvents(base, events),
    prev: next,
  };
}

export function formatEventLogTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
