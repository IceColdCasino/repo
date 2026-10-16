/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./share.circom";

// One wheel result. Sealed to the recipient key. The house shares first.
component main { public [hash] } = ShareHashOut(12, 1);
