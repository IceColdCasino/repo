/** Keno draw: count how many ticket spots appear in the 20-number draw. */

export const KENO_SHOE_SIZE = 80;
export const KENO_DRAW = 20;
export const MAX_KENO_SPOTS = 20;

export function assertValidKenoSpot(spot: number): void {
  if (!Number.isInteger(spot) || spot < 0 || spot >= KENO_SHOE_SIZE) {
    throw new Error(`Keno spot must be 0–79, got ${spot}`);
  }
}

export function assertUniqueKenoSpots(spots: readonly number[]): void {
  const seen = new Set<number>();
  for (const spot of spots) {
    if (seen.has(spot)) {
      throw new Error(`Duplicate keno spot ${spot}`);
    }
    seen.add(spot);
  }
}

export function assertValidKenoTicket(spots: readonly number[]): void {
  if (spots.length > MAX_KENO_SPOTS) {
    throw new Error(`Keno ticket has ${spots.length} spots, max ${MAX_KENO_SPOTS}`);
  }
  for (const spot of spots) {
    assertValidKenoSpot(spot);
  }
  assertUniqueKenoSpots(spots);
}

/** Pad to 20 with unused spots. Uniqueness applies only to the caller prefix. */
export function padKenoSpots(spots: readonly number[]): number[] {
  if (spots.length === MAX_KENO_SPOTS) {
    for (const spot of spots) {
      assertValidKenoSpot(spot);
    }
    return [...spots];
  }
  assertValidKenoTicket(spots);
  const used = new Set(spots);
  const out = [...spots];
  for (let i = 0; i < KENO_SHOE_SIZE && out.length < MAX_KENO_SPOTS; i++) {
    if (!used.has(i)) {
      out.push(i);
    }
  }
  return out.slice(0, MAX_KENO_SPOTS);
}

/** Match count for the first `nActualBets` spots against the 20-ball draw. */
export function evaluateKeno(
  draw: readonly number[],
  spots: readonly number[],
  nActualBets = spots.length,
): number {
  if (draw.length !== KENO_DRAW) {
    throw new Error(`expected ${KENO_DRAW} draw numbers, got ${draw.length}`);
  }
  const drawn = new Set(draw);
  let matches = 0;
  for (let i = 0; i < nActualBets; i++) {
    const spot = spots[i]!;
    assertValidKenoSpot(spot);
    if (drawn.has(spot)) {
      matches += 1;
    }
  }
  return matches;
}
