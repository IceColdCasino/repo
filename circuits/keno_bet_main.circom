/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./keno_bet.circom";

// Player + house only — spots are not broadcast to the rest of the table.
component main { public [hash] } = KenoBet(2, 20);
