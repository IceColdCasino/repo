/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./bingo_share.circom";

// 5-ball hashout window. Same circuit for 75- and 90-ball shoes.
// Each ball's partials get their own hash, and the public output is Poseidon
// of those five hashes, so one called ball can be revealed on its own.
component main { public [hash] } = BingoShareHashOut(12, 5);
