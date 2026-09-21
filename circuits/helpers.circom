/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";
include "circuits/gates.circom";

template LessThanOR(n) {
  signal input in[2];

  signal output out;

  component ltCheck;
  component orCheck;

  ltCheck = LessThan(n);
  ltCheck.in <== in;

  orCheck = OR();
  orCheck.a <== in[0] * (1 - ltCheck.out);
  orCheck.b <== in[1] * ltCheck.out;

  out <== orCheck.out;
}


template ConstrainLt(n, bound) {
  assert(bound <= 2 ** n);

  signal input in;

  signal boundSig;

  component lt;

  boundSig <== bound;
  
  lt = LessThan(n);
  lt.in[0] <== in;
  lt.in[1] <== boundSig;
  lt.out === 1;
}

template ConstrainGt(n, bound) {
  assert(bound <= 2 ** n);

  signal input in;

  signal boundSig;

  component lt;

  boundSig <== bound;

  // in > bound ⇔ bound < in
  lt = LessThan(n);
  lt.in[0] <== boundSig;
  lt.in[1] <== in;
  lt.out === 1;
}

template ConstrainLtSignal(n) {
  signal input in[2];

  component lt;

  lt = LessThan(n);
  lt.in <== in;
  lt.out === 1;
}

// When enabled=1, require in < bound. When enabled=0, unconstrained.
// Gate `in` by `enabled` so disabled checks do not feed large values into
// LessThan(n)'s Num2Bits(n+1).
template ConstrainLtIf(n, bound) {
  assert(bound <= 2 ** n);

  signal input enabled;
  signal input in;

  signal gated;
  signal boundSig;

  component lt;

  gated <== enabled * in;
  boundSig <== bound;

  lt = LessThan(n);
  lt.in[0] <== gated;
  lt.in[1] <== boundSig;
  enabled * (1 - lt.out) === 0;
}

template ConstrainNotEqual() {
  signal input in[2];
  
  component eq;
  
  eq = IsEqual();
  eq.in <== in;
  eq.out === 0;
}

template SortDescending(n, o) {
  signal input in[n];

  signal tmp[o][n + 1];   // Stores running maximums
  signal tmpIndex[o][n + 1]; // Stores running index of maximum
  signal tempIn[o + 1][n];    // Modified input array per iteration
  signal maxIndex[o];     // Final index of maximum for each iteration

  signal output out[o];

  component ltOrCheck[o][n];
  component maxCheck[o][n];
  component isZero[o][n];
  component andCheck[o][n];
  component updateUsed[o][n];

  // Initialize tempIn for first iteration
  for (var c = 0; c < n; c++) {
    tempIn[0][c] <== in[c];
  }

  // Sort: select top o elements in descending order
  for (var i = 0; i < o; i++) {
    tmp[i][0] <== 0;    // Initialize running maximum
    tmpIndex[i][0] <== 0; // Initialize running index

    // Find maximum unused element
    for (var c = 0; c < n; c++) {
      maxCheck[i][c] = GreaterThan(4);
      maxCheck[i][c].in[0] <== tempIn[i][c];
      maxCheck[i][c].in[1] <== tmp[i][c];

      isZero[i][c] = IsEqual();
      isZero[i][c].in[0] <== tempIn[i][c];
      isZero[i][c].in[1] <== 0;

      andCheck[i][c] = AND();
      andCheck[i][c].a <== maxCheck[i][c].out;
      andCheck[i][c].b <== 1 - isZero[i][c].out; // Only consider non-zero elements

      ltOrCheck[i][c] = LessThanOR(4);
      ltOrCheck[i][c].in[0] <== tmp[i][c];
      ltOrCheck[i][c].in[1] <== andCheck[i][c].out * tempIn[i][c];

      tmp[i][c + 1] <== ltOrCheck[i][c].out;
      tmpIndex[i][c + 1] <== tmpIndex[i][c] + andCheck[i][c].out * (c - tmpIndex[i][c]);
    }

    // Set final maximum and index for this iteration
    out[i] <== tmp[i][n];
    maxIndex[i] <== tmpIndex[i][n];

    // Update tempIn for next iteration
    for (var c = 0; c < n; c++) {
      updateUsed[i][c] = IsEqual();
      updateUsed[i][c].in[0] <== c;
      updateUsed[i][c].in[1] <== maxIndex[i];
      tempIn[i + 1][c] <== tempIn[i][c] * (1 - updateUsed[i][c].out);
    }
  }
}
