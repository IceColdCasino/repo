import type { GameSnapshot, SeatSnapshot } from '../backend/client';

export type AutoBetDecision =
  | { kind: 'wait'; reason: string }
  | {
      kind: 'act';
      action: 'check' | 'call' | 'raise';
      toCall: bigint;
      /** Chips added for raise/bet (undefined for check/call). */
      amount?: bigint;
    };

export function activeLiveSeats(seats: SeatSnapshot[]): SeatSnapshot[] {
  return seats.filter((seat) => !seat.folded);
}

export function chooseAutoBetAction(snapshot: GameSnapshot, localSeat: number): AutoBetDecision {
  const mine = snapshot.seats.find((seat) => seat.seat === localSeat);
  if (!mine || mine.folded) {
    return { kind: 'wait', reason: 'seat cannot act' };
  }
  const curBet = BigInt(snapshot.currentBet || '0');
  // Street-bet enrichment can briefly exceed currentBet; never compute a negative call.
  const myBet = BigInt(mine.bet ?? '0');
  const toCall = curBet > myBet ? curBet - myBet : 0n;

  // 2p PreFlop: call to match; never check. Completing call advances on-chain.
  // (Open-raise from behind the BB is rejected by validate_bet_v2 today.)
  if (snapshot.phase === 'PreFlop') {
    if (toCall > 0n) {
      return { kind: 'act', action: 'call', toCall };
    }
    return { kind: 'wait', reason: 'preflop matched — await street advance' };
  }

  return {
    kind: 'act',
    action: toCall > 0n ? 'call' : 'check',
    toCall,
  };
}

export function shouldAutoAdvanceStreet(snapshot: GameSnapshot): boolean {
  const streetPhases = new Set(['PreFlop', 'Flop', 'Turn', 'River']);
  if (!streetPhases.has(snapshot.phase)) {
    return false;
  }
  // Hole-ack window (Share → PreFlop, betting not open yet): ack holes / open
  // PreFlop — do not advanceStreet (that used to skip straight toward Showdown).
  if (snapshot.holesViewPending) {
    return false;
  }
  // While the betting round is open, the chain has an authoritative current_player.
  // Do not force-start the next street from the client; submit/check/call instead.
  if (snapshot.bettingRoundOpen) {
    return false;
  }
  // PreFlop with no blinds/action yet is still the hole-ack window even when
  // holesViewPending was omitted from a partial chain-event snapshot.
  if (snapshot.phase === 'PreFlop') {
    const cur = (() => {
      try {
        return BigInt(snapshot.currentBet || '0');
      } catch {
        return 0n;
      }
    })();
    const anySeatBet = snapshot.seats.some((seat) => {
      try {
        return BigInt(seat.bet || '0') > 0n;
      } catch {
        return false;
      }
    });
    if (cur === 0n && !anySeatBet) {
      return false;
    }
  }
  return true;
}
