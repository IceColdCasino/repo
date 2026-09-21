/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./roulette_bet.circom";

// Player + house only — up to 12 unique US placements.
component main { public [hash] } = RouletteBet(2, 38, 12);
