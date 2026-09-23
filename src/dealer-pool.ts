/**
 * Shared Dealer Pool: multiple stakers contribute pro-rata bankroll backing the house.
 * Arcium MPC holds encrypted pool balance on-chain; this module defines the math.
 */

import { splitProportionally, type SeatStake } from './seat-pools';

export interface PoolStake {
  /** Staker identity (Solana pubkey string or seat index for off-chain sim). */
  stakerId: string;
  shares: bigint;
}

export interface DealerPoolState {
  /** Aggregate pool bankroll available to cover player wins. */
  balance: bigint;
  stakes: PoolStake[];
}

export function totalPoolShares(stakes: PoolStake[]): bigint {
  return stakes.reduce((acc, s) => acc + s.shares, 0n);
}

export function poolStakeById(stakes: PoolStake[], stakerId: string): PoolStake | undefined {
  return stakes.find(s => s.stakerId === stakerId);
}

/**
 * Stake `amount` into the pool; mint shares pro-rata to existing balance.
 * First staker gets 1:1 shares.
 */
export function stakeIntoPool(
  pool: DealerPoolState,
  stakerId: string,
  amount: bigint,
): DealerPoolState {
  if (amount <= 0n) throw new Error('stake amount must be positive');

  const existing = poolStakeById(pool.stakes, stakerId);
  const totalShares = totalPoolShares(pool.stakes);
  const newShares = totalShares === 0n
    ? amount
    : (amount * totalShares) / pool.balance;

  const stakes = existing
    ? pool.stakes.map(s =>
        s.stakerId === stakerId
          ? { ...s, shares: s.shares + newShares }
          : s,
      )
    : [...pool.stakes, { stakerId, shares: newShares }];

  return {
    balance: pool.balance + amount,
    stakes,
  };
}

/**
 * Redeem `shares` for pro-rata balance. Cannot redeem more than staker holds.
 */
export function redeemFromPool(
  pool: DealerPoolState,
  stakerId: string,
  shares: bigint,
): { pool: DealerPoolState; payout: bigint } {
  if (shares <= 0n) throw new Error('shares must be positive');

  const stake = poolStakeById(pool.stakes, stakerId);
  if (!stake || stake.shares < shares) {
    throw new Error('insufficient pool shares');
  }

  const totalShares = totalPoolShares(pool.stakes);
  const payout = (pool.balance * shares) / totalShares;
  const remainingShares = stake.shares - shares;

  const stakes = remainingShares === 0n
    ? pool.stakes.filter(s => s.stakerId !== stakerId)
    : pool.stakes.map(s =>
        s.stakerId === stakerId ? { ...s, shares: remainingShares } : s,
      );

  return {
    pool: { balance: pool.balance - payout, stakes },
    payout,
  };
}

/**
 * Apply net pool P&L (after protocol fees) and distribute pro-rata to stakers.
 * Positive delta increases balance; negative delta decreases (capped at pool balance).
 */
export function applyPoolPnL(
  pool: DealerPoolState,
  netDelta: bigint,
): { pool: DealerPoolState; stakerDeltas: Map<string, bigint> } {
  const stakerDeltas = new Map<string, bigint>();
  if (pool.stakes.length === 0) {
    return { pool: { ...pool, balance: pool.balance + netDelta }, stakerDeltas };
  }

  const seatStakes: SeatStake[] = pool.stakes.map((s, i) => ({
    seatIndex: i,
    stake: s.shares,
  }));

  const shareDeltas = splitProportionally(netDelta, seatStakes);
  const stakes = pool.stakes.map((s, i) => {
    const delta = shareDeltas.get(i) ?? 0n;
    stakerDeltas.set(s.stakerId, delta);
    return s;
  });

  const newBalance = pool.balance + netDelta;
  if (newBalance < 0n) {
    throw new Error(`pool balance would go negative: ${newBalance}`);
  }

  return { pool: { balance: newBalance, stakes }, stakerDeltas };
}

/** Map dealer-pool seat stakes (by seat index) to pool staker IDs. */
export function dealerSeatsToPoolStakes(
  dealerStakes: SeatStake[],
  stakerIdForSeat: (seatIndex: number) => string,
): PoolStake[] {
  return dealerStakes.map(d => ({
    stakerId: stakerIdForSeat(d.seatIndex),
    shares: d.stake,
  }));
}
