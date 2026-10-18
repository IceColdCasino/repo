import type { GameSnapshot } from '../backend/client';

const BETTING_PHASES = new Set(['PreFlop', 'Flop', 'Turn', 'River']);

type LifecyclePhase = 1 | 2 | 3 | 4;

const LIFECYCLE_PHASE_LABELS: Record<LifecyclePhase, string> = {
  1: 'Registering',
  2: 'Shuffling',
  3: 'Dealing',
  4: 'Showdown',
};

function lifecyclePhaseLabel(phase: LifecyclePhase): string {
  return `Phase ${phase}: ${LIFECYCLE_PHASE_LABELS[phase]}`;
}

function lifecyclePhaseNumber(phase: GameSnapshot['phase']): LifecyclePhase | null {
  switch (phase) {
    case 'Register':
      return 1;
    case 'Shuffle':
      return 2;
    case 'Share':
      return 3;
    case 'Showdown':
      return 4;
    default:
      return null;
  }
}

function isLifecyclePhaseComplete(snapshot: GameSnapshot, phase: LifecyclePhase): boolean {
  const zk = snapshot.zk;
  if (phase === 4) {
    const sd = snapshot.zkShowdown;
    return Boolean(sd && sd.submittedCount >= sd.requiredCount);
  }
  if (!zk) {
    return false;
  }
  switch (phase) {
    case 1:
      return zk.elGamalPublicKeys.length > 0 && zk.registeredCount >= zk.elGamalPublicKeys.length;
    case 2:
      return zk.registeredCount > 0 && zk.shuffledCount >= zk.registeredCount;
    case 3: {
      const required = zk.requiredShares ?? zk.registeredCount;
      return required > 0 && zk.sharedCount >= required;
    }
    default:
      return false;
  }
}

function lifecycleStatusForPhase(snapshot: GameSnapshot, phase: LifecyclePhase): string {
  const label = lifecyclePhaseLabel(phase);
  if (isLifecyclePhaseComplete(snapshot, phase)) {
    return `${label} complete`;
  }
  if (phase === 1 && snapshot.zk) {
    const total = snapshot.zk.elGamalPublicKeys.length;
    const done = snapshot.zk.registeredCount;
    if (total > 0) {
      return `${label}: ${done}/${total} players registered`;
    }
  }
  if (phase === 2 && snapshot.zk) {
    const shufflerSeat = snapshot.zk.currentShufflerSeat;
    const total = snapshot.zk.registeredCount;
    const done = snapshot.zk.shuffledCount;
    if (shufflerSeat !== null && shufflerSeat !== undefined && done < total) {
      return `${label}: seat ${shufflerSeat} shuffling (${done}/${total} done)`;
    }
    if (total > 0) {
      return `${label}: ${done}/${total} shuffles done`;
    }
  }
  if (phase === 3 && snapshot.zk) {
    const total = snapshot.zk.requiredShares ?? snapshot.zk.registeredCount;
    const done = snapshot.zk.sharedCount ?? 0;
    const partials = snapshot.zk.hasSharedPartial ?? [];
    const provingSeats: number[] = [];
    for (let playerIndex = 0; playerIndex < total; playerIndex += 1) {
      if (partials[playerIndex] !== true) {
        const seatEntry = Object.entries(snapshot.playerIndexBySeat ?? {}).find(
          ([, idx]) => idx === playerIndex,
        );
        if (seatEntry) {
          provingSeats.push(Number(seatEntry[0]));
        }
      }
    }
    if (provingSeats.length > 1) {
      provingSeats.sort((a, b) => a - b);
      return `${label}: seats ${provingSeats.join(' + ')} proving in parallel (${done}/${total} submitted)`;
    }
    if (provingSeats.length === 1) {
      return `${label}: seat ${provingSeats[0]} proving (${done}/${total} submitted)`;
    }
    if (total > 0) {
      return `${label}: ${done}/${total} partials submitted`;
    }
  }
  if (phase === 4 && snapshot.zkShowdown) {
    const sd = snapshot.zkShowdown;
    return `${label}: awaiting proof (${sd.submittedCount}/${sd.requiredCount})`;
  }
  return `${label} is in progress`;
}

export function isHandLifecycleComplete(snapshot: GameSnapshot): boolean {
  if (snapshot.phase === 'Complete') {
    return true;
  }
  const phase = lifecyclePhaseNumber(snapshot.phase);
  if (phase === null) {
    return false;
  }
  return isLifecyclePhaseComplete(snapshot, phase);
}

/** Prefer lifecycle complete/idle text over busy proof text once the active phase is done. */
export function displayHandLifecycleStatus(snapshot: GameSnapshot, zkBusy: boolean): string {
  const lifecycle = formatHandLifecycleStatus(snapshot);
  if (!zkBusy || isHandLifecycleComplete(snapshot)) {
    return lifecycle;
  }
  return formatHandLifecycleBusyStatus(snapshot);
}

export function formatHandLifecycleStatus(snapshot: GameSnapshot): string {
  if (snapshot.phase === 'lobby') {
    return '';
  }
  if (!snapshot.zk && !snapshot.zkCrypto && !snapshot.handNumber) {
    return '';
  }

  if (snapshot.phase === 'Complete') {
    return `${lifecyclePhaseLabel(4)} complete`;
  }
  if (BETTING_PHASES.has(snapshot.phase)) {
    return `${lifecyclePhaseLabel(3)} complete · ${snapshot.phase}`;
  }

  const phase = lifecyclePhaseNumber(snapshot.phase);
  if (phase === null) {
    return '';
  }

  return lifecycleStatusForPhase(snapshot, phase);
}

export function formatHandLifecycleBusyStatus(snapshot: GameSnapshot): string {
  const phase = lifecyclePhaseNumber(snapshot.phase);
  if (phase === null) {
    return 'Hand setup is in progress';
  }
  const label = lifecyclePhaseLabel(phase);
  if (phase === 1 && snapshot.zk) {
    const total = snapshot.zk.elGamalPublicKeys.length;
    const done = snapshot.zk.registeredCount;
    if (total > 0) {
      return `${label}: generating proof (${done}/${total} registered)…`;
    }
  }
  return `${label}: generating proof…`;
}

export function formatBettingPhaseStatus(
  snapshot: GameSnapshot,
  localSeat: number | null,
  partialCount: number,
): string {
  const parts = [snapshot.phase];
  if (snapshot.bettingRoundOpen) {
    parts.push('betting open');
    if (localSeat !== null && snapshot.currentPlayerSeat === localSeat) {
      parts.push('your turn');
    } else if (snapshot.currentPlayerSeat !== null) {
      parts.push(`seat ${snapshot.currentPlayerSeat} to act`);
    }
  } else {
    parts.push('betting closed');
  }
  const reveal = snapshot.zkReveal;
  if (reveal?.shareComplete) {
    parts.push('share complete');
  }
  if (snapshot.holesViewPending) {
    const inHand = localSeat !== null && snapshot.seats.some(
      (seat) => seat.seat === localSeat && seat.playerIndex !== undefined && !seat.folded,
    );
    parts.push(inHand ? 'viewing hole cards…' : 'waiting for players to view cards');
  }
  if (reveal && reveal.revealedCardIndices.length > 0) {
    parts.push(`board revealed: ${reveal.revealedCardIndices.join(', ')}`);
  }
  if (partialCount > 0) {
    parts.push(`${partialCount} partials cached`);
  }
  return parts.join(' · ');
}

export function formatRevealStatus(snapshot: GameSnapshot, partialCount: number): string {
  const reveal = snapshot.zkReveal;
  if (!reveal) {
    return '';
  }
  const bits = [`revealed cards: ${reveal.revealedCardIndices.join(', ') || 'none'}`];
  if (reveal.newlyRevealed.length > 0) {
    bits.push(`new: ${reveal.newlyRevealed.join(', ')}`);
  }
  if (reveal.shareComplete) {
    bits.push('share complete');
  }
  if (reveal.allPartialsPublic) {
    bits.push('all partials public');
  }
  if (partialCount > 0) {
    bits.push(`${partialCount} partials cached`);
  }
  return bits.join(' · ');
}

/** @deprecated Use formatHandLifecycleStatus for the Hand Lifecycle panel. */
export function formatHandStatus(
  snapshot: GameSnapshot,
  localSeat: number | null,
  partialCount: number,
): string {
  if (BETTING_PHASES.has(snapshot.phase)) {
    return formatBettingPhaseStatus(snapshot, localSeat, partialCount);
  }
  const lifecycle = formatHandLifecycleStatus(snapshot);
  if (lifecycle) {
    return lifecycle;
  }
  const revealLine = formatRevealStatus(snapshot, partialCount);
  if (revealLine) {
    return revealLine;
  }
  return '';
}

export function isBettingPhase(phase: GameSnapshot['phase']): boolean {
  return BETTING_PHASES.has(phase);
}
