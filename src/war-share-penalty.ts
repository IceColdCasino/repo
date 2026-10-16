/**
 * War share stake.
 *
 * The casino shares first. Each other seat has `WAR_PLAYER_SHARE_MS` to share.
 * A seat that does not share in time loses its stake and its wager to the house.
 * The casino seat is not slashed by this path.
 */

export const WAR_SHARE_STAKE_MULTIPLE = 10n;
/** Time after the casino share for every player to share. */
export const WAR_PLAYER_SHARE_MS = 180_000;

export type WarShareSlash = {
  slashed: number[];
  houseFromStake: bigint;
  houseFromWager: bigint;
};

export function requiredWarShareStake(wager: bigint): bigint {
  if (wager <= 0n) throw new Error('wager must be positive');
  return wager * WAR_SHARE_STAKE_MULTIPLE;
}

/**
 * Slash every non-casino seat that has not shared once the deadline has passed.
 * Calling this before the deadline, or when every player shared, is rejected.
 */
export function slashUnsharedPlayers(args: {
  casinoSeat: number;
  casinoSharedAt: number;
  now: number;
  shared: readonly boolean[];
  wagers: readonly bigint[];
  stakes: readonly bigint[];
}): WarShareSlash {
  const { casinoSeat, shared, wagers, stakes } = args;
  if (wagers.length !== stakes.length || wagers.length !== shared.length) {
    throw new Error('each seat needs a wager, a stake, and a share flag');
  }
  if (casinoSeat < 0 || casinoSeat >= shared.length) {
    throw new Error('casino seat is not in the hand');
  }
  if (!shared[casinoSeat]) {
    throw new Error('the casino has not shared');
  }
  if (!Number.isFinite(args.casinoSharedAt) || !Number.isFinite(args.now)) {
    throw new Error('share time is not a timestamp');
  }
  if (args.now < args.casinoSharedAt + WAR_PLAYER_SHARE_MS) {
    throw new Error('players can still share');
  }

  const slashed: number[] = [];
  let houseFromStake = 0n;
  let houseFromWager = 0n;
  for (let seat = 0; seat < shared.length; seat++) {
    if (seat === casinoSeat || shared[seat]) continue;
    const wager = wagers[seat]!;
    const stake = stakes[seat]!;
    if (wager < 0n || stake < 0n) throw new Error(`seat ${seat} has a negative balance`);
    slashed.push(seat);
    houseFromWager += wager;
    houseFromStake += stake;
  }
  if (slashed.length === 0) {
    throw new Error('every player shared');
  }
  return { slashed, houseFromStake, houseFromWager };
}
