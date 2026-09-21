/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./slot_share.circom";

component main { public [hash] } = SlotShareHashOut(2, 3);
