/** Send a free check this many seconds before the on-chain deadline. */
export const AUTO_CHECK_LEAD_SECONDS = 3;

/**
 * The actor checks while a check is legal and the decision window is inside
 * its last few seconds. A missed window folds on chain.
 */
export function shouldAutoCheckBeforeDeadline(opts: {
  canAct: boolean;
  callAmount: number;
  busy: boolean;
  deadlineUnix: number;
  nowUnix: number;
  alreadySentForDeadline: number;
}): boolean {
  if (!opts.canAct || opts.busy || opts.callAmount > 0 || opts.deadlineUnix <= 0) return false;
  if (opts.alreadySentForDeadline === opts.deadlineUnix) return false;
  const left = opts.deadlineUnix - opts.nowUnix;
  return left <= AUTO_CHECK_LEAD_SECONDS && left > 0;
}
