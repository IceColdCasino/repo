/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./slot_showdown.circom";

// Five center stops; 3-row window is strip[(i±1) mod 22]. Single coin-bet decrypted.
component main { public [hash] } = ShowdownHashOut(2, 5, 22);
