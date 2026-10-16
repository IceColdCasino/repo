/** Pure bet-amount helpers — no Node / E2E deps (safe for WebView). */

export function resolveEncryptedBetAmount(
  action: string,
  opts: {
    amount?: bigint;
    playerCurrentBet: bigint;
    currentBet: bigint;
    playerBalance: bigint;
  },
): bigint {
  if (action === 'fold') {
    return 0n;
  }
  if (action === 'check') {
    if (opts.playerCurrentBet < opts.currentBet) {
      throw new Error('Cannot check facing a bet');
    }
    return 0n;
  }
  if (action === 'call') {
    const toCall = opts.currentBet - opts.playerCurrentBet;
    if (toCall < 0n) {
      throw new Error('Nothing to call');
    }
    return toCall > opts.playerBalance ? opts.playerBalance : toCall;
  }
  if (action === 'bet' || action === 'raise') {
    const add = opts.amount;
    if (add === undefined || add <= 0n) {
      throw new Error('Raise/bet requires a positive add amount');
    }
    return add > opts.playerBalance ? opts.playerBalance : add;
  }
  if (action === 'all-in') {
    return opts.playerBalance;
  }
  throw new Error(`Unknown action: ${action}`);
}
