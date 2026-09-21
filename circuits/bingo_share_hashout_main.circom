/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./share.circom";

// 5-ball hashout window. Same circuit for 75- and 90-ball shoes.
component main { public [hash] } = ShareHashOut(12, 5);
