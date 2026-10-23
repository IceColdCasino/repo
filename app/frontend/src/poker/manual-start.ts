/**
 * Manual poker setup: fund the personal account, sit with the minimum chips,
 * then press Start. The hand begins once more than one player is seated.
 */

export interface ManualSeat {
  seat: number;
  publicKey: string;
  chips?: string;
  seatEscrow?: string;
}

/** A hand can begin once more than one player is seated. */
export function tableReadyToStart(seats: ManualSeat[]): boolean {
  return seats.length > 1 && seats.every((seat) => Boolean(seat.publicKey));
}

/** True when this seated wallet can begin a hand. */
export function canBeginHand(publicKey: string, seats: ManualSeat[]): boolean {
  return tableReadyToStart(seats) && seats.some((seat) => seat.publicKey === publicKey);
}
