/**
 * Casino hand settlement: gross game outcome → protocol fees → dealer pool + player nets.
 *
 * ZK proves cards/outcomes; this module defines the transparent fee math that Arcium
 * MPC executes on encrypted balances. Player bets are always against the Dealer Pool.
 */

import {
  BACCARAT_FEES,
  BLACKJACK_FEES,
  WAR_FEES,
  type ProtocolFeeBreakdown,
  computeActionEdgeFees,
  computeBaccaratFees,
  computeSideBetFees,
  emptyFeeBreakdown,
  sumFeeBreakdown,
  type SideBetFeeSchedule,
} from './casino-fees';
import {
  applyPoolPnL,
  type DealerPoolState,
  stakeIntoPool,
} from './dealer-pool';
import type { HandOutcome } from './blackjack';
import {
  type HeadToHeadOutcome,
  type SeatStake,
  settleBlackjackTable,
  settleHeadToHead,
} from './seat-pools';

export interface HandSettlementInput {
  /** Sum of all player-side wagers this hand (main action). */
  totalAction: bigint;
  /** Optional side-bet handle (tie, insurance, etc.). */
  sideBetHandle?: bigint;
  sideBetSchedule?: SideBetFeeSchedule;
}

export interface HandSettlementResult {
  /** Per-seat net chip delta after fees (players + dealer-pool backing seats). */
  seatNets: Map<number, bigint>;
  /** Protocol treasury accrual this hand. */
  protocolFees: ProtocolFeeBreakdown;
  /** Net change to aggregate dealer pool balance (after fees). */
  poolNetDelta: bigint;
  /** Per pool staker delta after pro-rata split. */
  poolStakerDeltas: Map<string, bigint>;
  /** Updated dealer pool state. */
  pool: DealerPoolState;
}

function mergeFees(
  base: ProtocolFeeBreakdown,
  partial: Partial<ProtocolFeeBreakdown>,
): ProtocolFeeBreakdown {
  const merged = { ...base, ...partial };
  merged.total = sumFeeBreakdown(merged);
  return merged;
}

function grossPoolWinFromSeatNets(
  seatNets: Map<number, bigint>,
  dealerSeatIndices: number[],
): bigint {
  let poolGross = 0n;
  for (const seat of dealerSeatIndices) {
    poolGross += seatNets.get(seat) ?? 0n;
  }
  return poolGross > 0n ? poolGross : 0n;
}

function applyFeesToDealerSeats(
  seatNets: Map<number, bigint>,
  dealerSeatIndices: number[],
  winFees: bigint,
  actionFee: bigint,
): Map<number, bigint> {
  const adjusted = new Map(seatNets);
  const totalDealerFee = winFees + actionFee;
  if (totalDealerFee === 0n) return adjusted;

  const dealerGrossPositive = dealerSeatIndices.reduce((acc, s) => {
    const v = seatNets.get(s) ?? 0n;
    return acc + (v > 0n ? v : 0n);
  }, 0n);

  // Win/banker fees come from dealer gross win; action fee always from dealer side.
  if (winFees > 0n && dealerGrossPositive > 0n) {
    let allocated = 0n;
    const winSeats = dealerSeatIndices.filter(s => (seatNets.get(s) ?? 0n) > 0n);
    for (let i = 0; i < winSeats.length; i++) {
      const seat = winSeats[i]!;
      const gross = seatNets.get(seat)!;
      const feeShare = i === winSeats.length - 1
        ? winFees - allocated
        : (winFees * gross) / dealerGrossPositive;
      adjusted.set(seat, (adjusted.get(seat) ?? 0n) - feeShare);
      allocated += feeShare;
    }
  }

  if (actionFee > 0n) {
    let allocated = 0n;
    for (let i = 0; i < dealerSeatIndices.length; i++) {
      const seat = dealerSeatIndices[i]!;
      const feeShare = i === dealerSeatIndices.length - 1
        ? actionFee - allocated
        : actionFee / BigInt(dealerSeatIndices.length);
      adjusted.set(seat, (adjusted.get(seat) ?? 0n) - feeShare);
      allocated += feeShare;
    }
  }

  return adjusted;
}

function settleWithPool(
  grossSeatNets: Map<number, bigint>,
  dealerSeatIndices: number[],
  pool: DealerPoolState,
  fees: ProtocolFeeBreakdown,
): HandSettlementResult {
  const winFees = fees.poolWinEdgeShare + fees.bankerWinCommission + fees.sideBetProtocol;
  const actionFee = fees.actionCollection;

  const seatNets = (winFees > 0n || actionFee > 0n)
    ? applyFeesToDealerSeats(grossSeatNets, dealerSeatIndices, winFees, actionFee)
    : new Map(grossSeatNets);

  let poolNetDelta = 0n;
  for (const seat of dealerSeatIndices) {
    poolNetDelta += seatNets.get(seat) ?? 0n;
  }

  const { pool: updatedPool, stakerDeltas } = applyPoolPnL(pool, poolNetDelta);

  return {
    seatNets,
    protocolFees: fees,
    poolNetDelta,
    poolStakerDeltas: stakerDeltas,
    pool: updatedPool,
  };
}

/** Baccarat: 1:1 player payouts; 5% commission on pool wins; optional 1% action rake. */
export function settleBaccaratHand(
  outcome: HeadToHeadOutcome,
  playerStakes: SeatStake[],
  dealerStakes: SeatStake[],
  pool: DealerPoolState,
  input: HandSettlementInput,
): HandSettlementResult {
  const gross = settleHeadToHead(outcome, playerStakes, dealerStakes);
  const totalAction = input.totalAction;
  const dealerSeats = dealerStakes.map(d => d.seatIndex);
  const poolGrossWin = grossPoolWinFromSeatNets(gross, dealerSeats);

  const baccaratPartial = computeBaccaratFees(totalAction, poolGrossWin, BACCARAT_FEES);
  const sidePartial = input.sideBetHandle && input.sideBetHandle > 0n
    ? computeSideBetFees(input.sideBetHandle, input.sideBetSchedule)
    : { sideBetProtocol: 0n, sideBetPoolIncentive: 0n };

  const fees = mergeFees(emptyFeeBreakdown(), {
    ...baccaratPartial,
    ...sidePartial,
  });

  return settleWithPool(gross, dealerSeats, pool, fees);
}

/** War: traditional 1:1; 2.5% action + 2.5% edge on pool wins. */
export function settleWarHand(
  outcome: HeadToHeadOutcome,
  playerStakes: SeatStake[],
  dealerStakes: SeatStake[],
  pool: DealerPoolState,
  input: HandSettlementInput,
): HandSettlementResult {
  const gross = settleHeadToHead(outcome, playerStakes, dealerStakes);
  const dealerSeats = dealerStakes.map(d => d.seatIndex);
  const poolGrossWin = grossPoolWinFromSeatNets(gross, dealerSeats);

  const edgePartial = computeActionEdgeFees(
    input.totalAction,
    poolGrossWin,
    WAR_FEES,
  );
  const sidePartial = input.sideBetHandle && input.sideBetHandle > 0n
    ? computeSideBetFees(input.sideBetHandle, input.sideBetSchedule)
    : { sideBetProtocol: 0n, sideBetPoolIncentive: 0n };

  const fees = mergeFees(emptyFeeBreakdown(), { ...edgePartial, ...sidePartial });
  return settleWithPool(gross, dealerSeats, pool, fees);
}

/** Blackjack: 2% action + 2% edge on pool wins; standard hand payouts. */
export function settleBlackjackHand(
  outcomes: HandOutcome[][],
  handStakes: Map<string, bigint>,
  dealerStakes: SeatStake[],
  activePlayerCount: number,
  maxPlayers: number,
  fullTableBankroll: bigint,
  pool: DealerPoolState,
  input: HandSettlementInput,
): HandSettlementResult {
  const gross = settleBlackjackTable(
    outcomes,
    handStakes,
    dealerStakes,
    activePlayerCount,
    maxPlayers,
    fullTableBankroll,
  );
  const dealerSeats = dealerStakes.map(d => d.seatIndex);
  const poolGrossWin = grossPoolWinFromSeatNets(gross, dealerSeats);

  const edgePartial = computeActionEdgeFees(
    input.totalAction,
    poolGrossWin,
    BLACKJACK_FEES,
  );
  const sidePartial = input.sideBetHandle && input.sideBetHandle > 0n
    ? computeSideBetFees(input.sideBetHandle, input.sideBetSchedule)
    : { sideBetProtocol: 0n, sideBetPoolIncentive: 0n };

  const fees = mergeFees(emptyFeeBreakdown(), { ...edgePartial, ...sidePartial });
  return settleWithPool(gross, dealerSeats, pool, fees);
}

/** Convenience: empty pool seeded from dealer seat stakes at hand start. */
export function poolFromDealerStakes(
  dealerStakes: SeatStake[],
  stakerIdForSeat: (seatIndex: number) => string = s => `seat-${s}`,
): DealerPoolState {
  let pool: DealerPoolState = { balance: 0n, stakes: [] };
  for (const { seatIndex, stake } of dealerStakes) {
    pool = stakeIntoPool(pool, stakerIdForSeat(seatIndex), stake);
  }
  return pool;
}

export function totalPlayerAction(playerStakes: SeatStake[]): bigint {
  return playerStakes.reduce((acc, s) => acc + s.stake, 0n);
}

export type { DealerPoolState };
