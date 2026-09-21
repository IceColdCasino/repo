/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./craps_bet.circom";

// Player + house only — up to 12 unique Wikipedia craps families.
component main { public [hash] } = CrapsBet(2, 12);
