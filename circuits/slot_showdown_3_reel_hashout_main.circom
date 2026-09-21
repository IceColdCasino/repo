/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./slot_showdown.circom";

// Classic 3-reel center line. Single coin-bet (1 / 2 / 3) decrypted from share.
component main { public [hash] } = ShowdownHashOut(2, 3, 22);
