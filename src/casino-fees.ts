/**
 * Fixed, transparent commission schedule for casino games vs the shared Dealer Pool.
 * All rates are in basis points (1 bps = 0.01%). No hidden edges beyond these values.
 */

export type CasinoGame = 'baccarat' | 'blackjack' | 'war' | 'roulette' | 'craps' | 'keno' | 'slots' | 'bingo';

/** Baccarat: 5% on Banker (pool) wins; optional 1% on total action. */
export interface BaccaratFeeSchedule {
  readonly bankerWinCommissionBps: number;
  readonly totalActionCollectionBps: number;
}

/** Blackjack / War: action collection + edge share on pool wins. */
export interface ActionEdgeFeeSchedule {
  readonly totalActionCollectionBps: number;
  readonly poolWinEdgeShareBps: number;
}

export interface SideBetFeeSchedule {
  /** Protocol share of side-bet handle (default 100%). */
  readonly protocolShareBps: number;
  /** Optional incentive routed to the dealer pool (0–30%). */
  readonly poolIncentiveShareBps: number;
}

/** Verified fixed numbers — do not change without explicit protocol upgrade. */
export const BACCARAT_FEES: BaccaratFeeSchedule = {
  bankerWinCommissionBps: 500,
  totalActionCollectionBps: 100,
};

export const BLACKJACK_FEES: ActionEdgeFeeSchedule = {
  totalActionCollectionBps: 200,
  poolWinEdgeShareBps: 200,
};

export const WAR_FEES: ActionEdgeFeeSchedule = {
  totalActionCollectionBps: 250,
  poolWinEdgeShareBps: 250,
};

export const ROULETTE_FEES: ActionEdgeFeeSchedule = {
  totalActionCollectionBps: 200,
  poolWinEdgeShareBps: 200,
};

export const SIDE_BET_FEES: SideBetFeeSchedule = {
  protocolShareBps: 10_000,
  poolIncentiveShareBps: 0,
};

export const MAX_POOL_INCENTIVE_BPS = 3000;

export function feeFromBps(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new Error('amount must be non-negative');
  if (bps < 0 || bps > 10_000) throw new Error(`bps ${bps} out of range 0..10000`);
  return (amount * BigInt(bps)) / 10_000n;
}

export function validateSideBetSchedule(schedule: SideBetFeeSchedule): void {
  if (schedule.protocolShareBps + schedule.poolIncentiveShareBps > 10_000) {
    throw new Error('side bet shares exceed 100%');
  }
  if (schedule.poolIncentiveShareBps > MAX_POOL_INCENTIVE_BPS) {
    throw new Error(`pool incentive exceeds ${MAX_POOL_INCENTIVE_BPS} bps`);
  }
}

export interface ProtocolFeeBreakdown {
  actionCollection: bigint;
  poolWinEdgeShare: bigint;
  bankerWinCommission: bigint;
  sideBetProtocol: bigint;
  sideBetPoolIncentive: bigint;
  total: bigint;
}

export function emptyFeeBreakdown(): ProtocolFeeBreakdown {
  return {
    actionCollection: 0n,
    poolWinEdgeShare: 0n,
    bankerWinCommission: 0n,
    sideBetProtocol: 0n,
    sideBetPoolIncentive: 0n,
    total: 0n,
  };
}

export function sumFeeBreakdown(fees: ProtocolFeeBreakdown): bigint {
  return (
    fees.actionCollection
    + fees.poolWinEdgeShare
    + fees.bankerWinCommission
    + fees.sideBetProtocol
    + fees.sideBetPoolIncentive
  );
}

/** Action rake + optional edge share on positive pool gross win. */
export function computeActionEdgeFees(
  totalAction: bigint,
  poolGrossWin: bigint,
  schedule: ActionEdgeFeeSchedule,
): Pick<ProtocolFeeBreakdown, 'actionCollection' | 'poolWinEdgeShare'> {
  const actionCollection = feeFromBps(totalAction, schedule.totalActionCollectionBps);
  const poolWinEdgeShare = poolGrossWin > 0n
    ? feeFromBps(poolGrossWin, schedule.poolWinEdgeShareBps)
    : 0n;
  return { actionCollection, poolWinEdgeShare };
}

/** Baccarat: 5% on pool wins + optional 1% action collection. */
export function computeBaccaratFees(
  totalAction: bigint,
  poolGrossWin: bigint,
  schedule: BaccaratFeeSchedule = BACCARAT_FEES,
): Pick<ProtocolFeeBreakdown, 'actionCollection' | 'bankerWinCommission'> {
  const actionCollection = feeFromBps(totalAction, schedule.totalActionCollectionBps);
  const bankerWinCommission = poolGrossWin > 0n
    ? feeFromBps(poolGrossWin, schedule.bankerWinCommissionBps)
    : 0n;
  return { actionCollection, bankerWinCommission };
}

/** Side-bet handle split between protocol treasury and dealer pool incentive. */
export function computeSideBetFees(
  sideBetHandle: bigint,
  schedule: SideBetFeeSchedule = SIDE_BET_FEES,
): Pick<ProtocolFeeBreakdown, 'sideBetProtocol' | 'sideBetPoolIncentive'> {
  validateSideBetSchedule(schedule);
  return {
    sideBetProtocol: feeFromBps(sideBetHandle, schedule.protocolShareBps),
    sideBetPoolIncentive: feeFromBps(sideBetHandle, schedule.poolIncentiveShareBps),
  };
}
