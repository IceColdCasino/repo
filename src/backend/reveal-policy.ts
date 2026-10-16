/**
 * On-chain reveal_card authorization mirror.
 *
 * Betting phase: 0=none, 1=preflop, 2=flop, 3=turn, 4=river, 5=showdown.
 * Before showdown, a recipient may reveal only their own active/show-on-fold
 * hole cards. At showdown, any recipient may reveal non-folded holes and
 * show-on-fold holes.
 * Folded+mucked holes are never revealable. Unused empty-seat holes and
 * undealt deck indices are never revealable.
 * Flop 20–22 / turn 23 / river 24 require phase >= 2 / 3 / 4.
 */
import {
  flopIndices,
  holePlayerIndexForCard,
  riverIndex,
  turnIndex,
} from './card-layout';

export class CardRevealNotAllowedError extends Error {
  readonly code = 'CardRevealNotAllowed' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CardRevealNotAllowedError';
  }
}

export class CardIndexNotInPlayError extends Error {
  readonly code = 'CardIndexNotInPlay' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CardIndexNotInPlayError';
  }
}

export class HoleCardsMuckedError extends Error {
  readonly code = 'HoleCardsMucked' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HoleCardsMuckedError';
  }
}

export type RevealPolicyError =
  | CardRevealNotAllowedError
  | CardIndexNotInPlayError
  | HoleCardsMuckedError;

/** Limb count published per card: (numPlayers - 1) × 4 BN254 limbs. */
export function expectedRevealLimbCount(numPlayers: number): number {
  if (numPlayers < 2 || numPlayers > 10) {
    throw new CardRevealNotAllowedError(
      `CardRevealNotAllowed: numPlayers must be 2..10, got ${numPlayers}`,
    );
  }
  return (numPlayers - 1) * 4;
}

export function holeOwnerRevealable(
  playerIndex: number,
  foldedMask = 0,
  showOnFoldMask = 0,
): boolean {
  const bit = 1 << playerIndex;
  if ((foldedMask & bit) === 0) {
    return true;
  }
  return (showOnFoldMask & bit) !== 0;
}

export type AssertCardRevealAllowedOptions = {
  recipientIndex?: number;
  foldedMask?: number;
  showOnFoldMask?: number;
};

export function isCardRevealAllowed(
  cardIndex: number,
  numPlayers: number,
  bettingPhase: number,
  verified: boolean,
  recipientIndexOrOpts?: number | AssertCardRevealAllowedOptions,
): boolean {
  try {
    if (typeof recipientIndexOrOpts === 'number' || recipientIndexOrOpts === undefined) {
      assertCardRevealAllowed(
        cardIndex,
        numPlayers,
        bettingPhase,
        verified,
        { recipientIndex: recipientIndexOrOpts },
      );
    } else {
      assertCardRevealAllowed(
        cardIndex,
        numPlayers,
        bettingPhase,
        verified,
        recipientIndexOrOpts,
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function assertCardRevealAllowed(
  cardIndex: number,
  numPlayers: number,
  bettingPhase: number,
  verified: boolean,
  recipientIndexOrOpts?: number | AssertCardRevealAllowedOptions,
): void {
  const opts: AssertCardRevealAllowedOptions =
    typeof recipientIndexOrOpts === 'number' || recipientIndexOrOpts === undefined
      ? { recipientIndex: recipientIndexOrOpts }
      : recipientIndexOrOpts;
  const {
    recipientIndex,
    foldedMask = 0,
    showOnFoldMask = 0,
  } = opts;

  if (!verified) {
    throw new CardRevealNotAllowedError(
      'CardRevealNotAllowed: deck hash not verified',
    );
  }
  if (numPlayers < 2 || numPlayers > 10) {
    throw new CardRevealNotAllowedError(
      `CardRevealNotAllowed: numPlayers must be 2..10, got ${numPlayers}`,
    );
  }
  if (
    recipientIndex !== undefined
    && (!Number.isInteger(recipientIndex) || recipientIndex < 0 || recipientIndex >= numPlayers)
  ) {
    throw new CardRevealNotAllowedError(
      `CardRevealNotAllowed: recipient ${recipientIndex} is not an active player`,
    );
  }

  const holeOwner = holePlayerIndexForCard(cardIndex, numPlayers);
  if (holeOwner !== null) {
    if (!holeOwnerRevealable(holeOwner, foldedMask, showOnFoldMask)) {
      throw new HoleCardsMuckedError(
        `HoleCardsMucked: player ${holeOwner} folded and mucked card ${cardIndex}`,
      );
    }
    if (bettingPhase < 1) {
      throw new CardRevealNotAllowedError(
        `CardRevealNotAllowed: hole card ${cardIndex} requires betting_phase >= 1 (preflop), got ${bettingPhase}`,
      );
    }
    if (
      recipientIndex !== undefined
      && bettingPhase < 5
      && holeOwner !== recipientIndex
    ) {
      throw new CardRevealNotAllowedError(
        `CardRevealNotAllowed: recipient ${recipientIndex} cannot reveal player ${holeOwner}'s hole card ${cardIndex} before showdown`,
      );
    }
    return;
  }

  const [f0, f1, f2] = flopIndices();
  if (cardIndex === f0 || cardIndex === f1 || cardIndex === f2) {
    if (bettingPhase < 2) {
      throw new CardRevealNotAllowedError(
        `CardRevealNotAllowed: flop card ${cardIndex} requires betting_phase >= 2, got ${bettingPhase}`,
      );
    }
    return;
  }

  if (cardIndex === turnIndex()) {
    if (bettingPhase < 3) {
      throw new CardRevealNotAllowedError(
        `CardRevealNotAllowed: turn card ${cardIndex} requires betting_phase >= 3, got ${bettingPhase}`,
      );
    }
    return;
  }

  if (cardIndex === riverIndex()) {
    if (bettingPhase < 4) {
      throw new CardRevealNotAllowedError(
        `CardRevealNotAllowed: river card ${cardIndex} requires betting_phase >= 4, got ${bettingPhase}`,
      );
    }
    return;
  }

  throw new CardIndexNotInPlayError(
    `CardIndexNotInPlay: card ${cardIndex} is unused for ${numPlayers} players`,
  );
}
