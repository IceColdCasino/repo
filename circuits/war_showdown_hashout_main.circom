/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./war_showdown.circom";

// Expose only the authenticated receipt and roots, never the clear winner.
component main { public [hash] } = ShowdownHashOut(12, 8);
