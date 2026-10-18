import type { APIRequestContext } from '@playwright/test';

export const API = 'http://127.0.0.1:3847/api';
export const GAME_ID = 'local-table';

export type GameSnapshot = {
  phase: string;
  bettingRoundOpen: boolean;
  currentPlayerSeat: number | null;
  currentBet: string;
  actionOrder?: number[];
  boardCards?: number[];
  holeCards?: Record<string, [number, number]>;
  e2eDealValues?: Record<number, number>;
  zkCrypto?: unknown;
  zkShowdown?: {
    requested?: boolean;
    requiredCount?: number;
    submittedCount?: number;
    submitterSeat?: number | null;
  };
  zkReveal?: {
    shareComplete?: boolean;
    revealedCardIndices?: number[];
    allPartialsPublic?: boolean;
    holePartialsUnlocked?: boolean;
  };
  holesViewPending?: boolean;
  handResult?: {
    handNumber: number;
    reason: string;
    potResults: Array<{ potIndex?: number; amount: string; winnerSeats: number[] }>;
    seatHands: Array<{
      seat: number;
      folded: boolean;
      holeCards: [number, number];
      handDescription?: string;
    }>;
    boardCards: number[];
  };
  seats: Array<{ seat: number; bet: string; chips: string; publicKey?: string; folded?: boolean }>;
};

const E2E_VISUAL_SHOWDOWN_PROOF = {
  pi_a: ['0', '0'],
  pi_b: [['0', '0'], ['0', '0']],
  pi_c: ['0', '0'],
};

export async function resetTable(request: APIRequestContext): Promise<void> {
  await request.post(`${API}/admin/reset?backend=local&e2eZkVisual=1`);
}

export async function joinSeat(
  request: APIRequestContext,
  seat: number,
  publicKey: string,
): Promise<void> {
  await request.post(`${API}/games/${GAME_ID}/join?backend=local`, {
    data: { seat, publicKey },
  });
}

export async function addChips(
  request: APIRequestContext,
  seat: number,
  amount: string,
): Promise<void> {
  await request.post(`${API}/games/${GAME_ID}/add-chips?backend=local`, {
    data: { seat, amount },
  });
}

export async function fetchState(request: APIRequestContext): Promise<GameSnapshot> {
  const res = await request.get(`${API}/games/${GAME_ID}?backend=local`);
  if (!res.ok()) {
    throw new Error(`Failed to fetch game state: ${res.status()}`);
  }
  return res.json() as Promise<GameSnapshot>;
}

export async function startHand(request: APIRequestContext): Promise<GameSnapshot> {
  const res = await request.post(`${API}/games/${GAME_ID}/start?backend=local`);
  if (!res.ok()) {
    throw new Error(`Failed to start hand: ${res.status()} ${await res.text()}`);
  }
  return res.json() as Promise<GameSnapshot>;
}

export async function placeBet(
  request: APIRequestContext,
  seat: number,
  action: 'fold' | 'check' | 'call' | 'raise',
  amount?: string,
): Promise<GameSnapshot> {
  const res = await request.post(`${API}/games/${GAME_ID}/action?backend=local`, {
    data: { seat, action, amount },
  });
  if (!res.ok()) {
    throw new Error(`Bet failed (${action} seat ${seat}): ${await res.text()}`);
  }
  return res.json() as Promise<GameSnapshot>;
}

export async function advanceStreet(request: APIRequestContext): Promise<GameSnapshot> {
  const res = await request.post(`${API}/games/${GAME_ID}/advance?backend=local`);
  if (!res.ok()) {
    throw new Error(`Advance street failed: ${await res.text()}`);
  }
  return res.json() as Promise<GameSnapshot>;
}

export async function acknowledgeHoleCards(
  request: APIRequestContext,
  seat: number,
): Promise<GameSnapshot> {
  const res = await request.post(`${API}/games/${GAME_ID}/ack-holes?backend=local`, {
    data: { seat },
  });
  if (!res.ok()) {
    throw new Error(`Ack holes failed (seat ${seat}): ${await res.text()}`);
  }
  return res.json() as Promise<GameSnapshot>;
}

export async function acknowledgeAllHoleCards(request: APIRequestContext): Promise<GameSnapshot> {
  let state = await fetchState(request);
  for (const seat of state.actionOrder ?? []) {
    if (state.bettingRoundOpen) {
      break;
    }
    state = await acknowledgeHoleCards(request, seat);
  }
  return state;
}

export async function completeBettingRound(request: APIRequestContext): Promise<GameSnapshot> {
  let state = await fetchState(request);
  const startPhase = state.phase;
  if (!state.bettingRoundOpen && state.holesViewPending) {
    state = await acknowledgeAllHoleCards(request);
  }
  let guard = 0;
  while (state.bettingRoundOpen && state.phase === startPhase && guard < 40) {
    guard += 1;
    const seat = state.currentPlayerSeat;
    if (seat === null) {
      break;
    }
    const seatInfo = state.seats.find((entry) => entry.seat === seat);
    if (!seatInfo) {
      break;
    }
    const toCall = BigInt(state.currentBet) - BigInt(seatInfo.bet);
    state = await placeBet(request, seat, toCall > 0n ? 'call' : 'check');
  }
  return state;
}

export async function setupTwoPlayerTable(request: APIRequestContext): Promise<void> {
  await resetTable(request);
  await joinSeat(request, 0, '11111111111111111111111111111112');
  await joinSeat(request, 1, '22222222222222222222222222222223');
  await addChips(request, 0, '2000');
  await addChips(request, 1, '2000');
}

export async function submitE2eShowdown(
  request: APIRequestContext,
  seat = 0,
): Promise<GameSnapshot> {
  const res = await request.post(`${API}/games/${GAME_ID}/showdown?backend=local`, {
    data: {
      seat,
      proof: E2E_VISUAL_SHOWDOWN_PROOF,
      publicSignals: ['0', '0'],
    },
  });
  if (!res.ok()) {
    throw new Error(`Showdown submit failed: ${res.status()} ${await res.text()}`);
  }
  return res.json() as Promise<GameSnapshot>;
}

export async function playThroughToPhase(
  request: APIRequestContext,
  targetPhase: 'PreFlop' | 'Flop' | 'Turn' | 'River' | 'Showdown' | 'Complete',
): Promise<GameSnapshot> {
  let state = await fetchState(request);
  const order: Array<'PreFlop' | 'Flop' | 'Turn' | 'River' | 'Showdown'> = [
    'PreFlop',
    'Flop',
    'Turn',
    'River',
    'Showdown',
  ];
  const streetTarget = targetPhase === 'Complete' ? 'Showdown' : targetPhase;
  const targetIndex = order.indexOf(streetTarget);
  if (targetIndex < 0) {
    throw new Error(`Unknown phase ${targetPhase}`);
  }

  for (let index = 0; index < targetIndex; index += 1) {
    const street = order[index]!;
    state = await fetchState(request);
    if (state.phase === 'Complete' || state.phase === targetPhase) {
      break;
    }
    const currentIndex = order.indexOf(state.phase as typeof street);
    if (currentIndex > index) {
      continue;
    }
    if (state.phase === street && state.bettingRoundOpen) {
      state = await completeBettingRound(request);
    }
    state = await fetchState(request);
    if (state.phase === street && !state.bettingRoundOpen && state.phase !== 'Showdown') {
      state = await advanceStreet(request);
    }
  }
  state = await fetchState(request);
  if (targetPhase === 'Complete' && state.phase !== 'Complete') {
    const seat = state.zkShowdown?.submitterSeat ?? state.actionOrder?.[0] ?? 0;
    state = await submitE2eShowdown(request, seat);
  }
  return state;
}
