/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./bet.circom";
include "./hash.circom";
include "./helpers.circom";
include "circuits/comparators.circom";
include "circuits/gates.circom";

// Pairwise uniqueness among non-zero cells (zeros / blanks may repeat).
template UniqueNonZero(n) {
  var nPairs = n * (n - 1) / 2;

  signal input cells[n];

  signal bothActive[nPairs];

  component isZero[n];
  component eq[nPairs];

  for (var i = 0; i < n; i++) {
    isZero[i] = IsZero();
    isZero[i].in <== cells[i];
  }

  var k = 0;
  for (var i = 0; i < n; i++) {
    for (var j = i + 1; j < n; j++) {
      bothActive[k] <== (1 - isZero[i].out) * (1 - isZero[j].out);
      eq[k] = IsEqual();
      eq[k].in <== [cells[i], cells[j]];
      bothActive[k] * eq[k].out === 0;
      k++;
    }
  }
}

// When enabled=1, require lo <= in <= hi. Disabled checks are unconstrained.
template ConstrainInRangeIf(n, lo, hi) {
  assert(hi < 2 ** n);
  assert(lo >= 1 && lo <= hi);

  signal input enabled;
  signal input in;

  signal gated;
  signal hiBound;

  component ge;
  component lt;

  gated <== enabled * in;
  hiBound <== hi + 1;

  ge = GreaterEqThan(n);
  ge.in[0] <== gated + (1 - enabled) * lo;
  ge.in[1] <== lo;
  enabled * (1 - ge.out) === 0;

  lt = LessThan(n);
  lt.in[0] <== gated;
  lt.in[1] <== hiBound;
  enabled * (1 - lt.out) === 0;
}

template CommitCardCells(nCells) {
  signal input publicKey[2];
  signal input plaintextCells[nCells];
  signal input randomness[nCells];

  signal output out[nCells][4];

  component babyPbk[nCells];
  component encrypt[nCells];

  for (var i = 0; i < nCells; i++) {
    babyPbk[i] = parallel BabyPbk();
    babyPbk[i].in <== plaintextCells[i] + 1;

    encrypt[i] = parallel Encrypt();
    encrypt[i].plaintext <== [babyPbk[i].Ax, babyPbk[i].Ay];
    encrypt[i].publicKey <== publicKey;
    encrypt[i].randomness <== randomness[i];

    out[i] <== encrypt[i].ciphertext;
  }
}

// 75-ball US card: 5×5, columns B/I/N/G/O in 1–15 / 16–30 / 31–45 / 46–60 / 61–75.
// Center cell (index 12) is the free space (0). Other 24 numbers unique.
template BingoCard75() {
  signal input hash;
  signal input publicKey[2];
  signal input plaintextCells[25];
  signal input randomness[25];

  signal output out[25][4];

  var lo[5] = [1, 16, 31, 46, 61];
  var hi[5] = [15, 30, 45, 60, 75];

  component finalHash;
  component unique;
  component range[25];
  component commit;
  component isCenter[25];

  plaintextCells[12] === 0;

  unique = UniqueNonZero(25);
  unique.cells <== plaintextCells;

  for (var i = 0; i < 25; i++) {
    isCenter[i] = IsEqual();
    isCenter[i].in <== [i, 12];

    range[i] = ConstrainInRangeIf(7, lo[i % 5], hi[i % 5]);
    range[i].enabled <== 1 - isCenter[i].out;
    range[i].in <== plaintextCells[i];
  }

  finalHash = Poseidon(3);
  finalHash.inputs <== [publicKey[0], publicKey[1], 25];
  hash === finalHash.out;

  commit = CommitCardCells(25);
  commit.publicKey <== publicKey;
  commit.plaintextCells <== plaintextCells;
  commit.randomness <== randomness;
  out <== commit.out;
}

// 90-ball UK ticket: 3×9, 15 numbers + 12 blanks (0), 5 numbers per row.
// Column bands 1–9, 10–19, …, 80–90 (col 8 is 80–90).
template BingoCard90() {
  signal input hash;
  signal input publicKey[2];
  signal input plaintextCells[27];
  signal input randomness[27];

  signal output out[27][4];

  var lo[9] = [1, 10, 20, 30, 40, 50, 60, 70, 80];
  var hi[9] = [9, 19, 29, 39, 49, 59, 69, 79, 90];

  signal rowCount[3][10];
  signal isFilled[27];

  component finalHash;
  component unique;
  component isZero[27];
  component range[27];
  component commit;
  component rowEq[3];

  unique = UniqueNonZero(27);
  unique.cells <== plaintextCells;

  for (var r = 0; r < 3; r++) {
    rowCount[r][0] <== 0;
    for (var c = 0; c < 9; c++) {
      var i = r * 9 + c;
      isZero[i] = IsZero();
      isZero[i].in <== plaintextCells[i];
      isFilled[i] <== 1 - isZero[i].out;

      range[i] = ConstrainInRangeIf(7, lo[c], hi[c]);
      range[i].enabled <== isFilled[i];
      range[i].in <== plaintextCells[i];

      rowCount[r][c + 1] <== rowCount[r][c] + isFilled[i];
    }
    rowEq[r] = IsEqual();
    rowEq[r].in <== [rowCount[r][9], 5];
    rowEq[r].out === 1;
  }

  finalHash = Poseidon(3);
  finalHash.inputs <== [publicKey[0], publicKey[1], 27];
  hash === finalHash.out;

  commit = CommitCardCells(27);
  commit.publicKey <== publicKey;
  commit.plaintextCells <== plaintextCells;
  commit.randomness <== randomness;
  out <== commit.out;
}
