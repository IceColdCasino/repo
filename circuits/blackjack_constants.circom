/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

// Blackjack table constants (must match TypeScript src/blackjack.ts)
//
// Shuffle: 8 seats (7 players + dealer), 8-deck shoe
// Share:   16 encrypted cards per chunked proofs
// Action:  one hand (maxCardsPerHand); bust skips showdown
// Showdown (production): one hand + dealer = 11 + 13 = 24 cards

function maxSeats() { return 8; }
function maxPlayers() { return 7; }
function maxHands() { return 4; }           // max 3 splits → 4 hands (layout / game logic)
function maxCardsPerHand() { return 11; }    // per-hand cap
function maxDealerCards() { return 13; }     // configurable S17 (12) / H17 (13)
function maxOneHandShowdownCards() { return maxCardsPerHand() + maxDealerCards(); } // 24
function shoeSize() { return 8; }