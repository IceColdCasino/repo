/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./blackjack_share.circom";

// 16-card chunk. The house seat is the dealer. Each card's partials get their
// own hash, and the public output is the fold of those hashes. The initial
// deal gives each seat two cards, so one card can be revealed on its own.
component main { public [hash] } = BlackjackShareHashOut(8, 16);
