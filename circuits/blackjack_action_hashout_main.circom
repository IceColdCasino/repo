/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./blackjack_action.circom";

component main { public [hash] } = ActionHashOut(8);
