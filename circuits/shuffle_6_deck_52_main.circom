/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./shuffle.circom";

// Shared six-deck shuffle: 12 player slots (blackjack pads 8→12, war uses 12).
component main { public [hash] } = Shuffle(12, 6, 52);
