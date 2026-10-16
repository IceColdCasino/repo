/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./share.circom";

// All recipient partials for one ball. 11 seats × 4 limbs = 44 field elements,
// hashed with the same 12-wide Poseidon chunks as HashFlat.
template HashOneBall(nOthers) {
  signal input in[nOthers][4];
  signal output out;

  component hash = HashFlat(nOthers * 4);
  var t = 0;
  for (var i = 0; i < nOthers; i++) {
    for (var k = 0; k < 4; k++) {
      hash.in[t] <== in[i][k];
      t++;
    }
  }
  out <== hash.out;
}

// Ball hashes are internal. The only public output is Poseidon(5) of the five
// ball hashes. Five inputs fit the on-chain hasher, so the fold is one call.
// The chain recomputes a ball hash from that ball's partials, so one called
// ball can be opened without the other four in the window.
template BingoBallHashes(nPlayers, nBalls) {
  var nOthers = nPlayers - 1;
  assert(nBalls == 5);

  signal input partials[nOthers][nBalls][4];
  signal ball[nBalls];
  signal output out;

  component hashes[nBalls];
  component finalHash;

  for (var b = 0; b < nBalls; b++) {
    hashes[b] = parallel HashOneBall(nOthers);
    for (var i = 0; i < nOthers; i++) {
      for (var k = 0; k < 4; k++) {
        hashes[b].in[i][k] <== partials[i][b][k];
      }
    }
  }
  for (var b = 0; b < nBalls; b++) {
    ball[b] <== hashes[b].out;
  }

  finalHash = Poseidon(5);
  for (var b = 0; b < nBalls; b++) {
    finalHash.inputs[b] <== ball[b];
  }
  out <== finalHash.out;
}

template BingoShareHashOut(nPlayers, nBalls) {
  var nOthers = nPlayers - 1;

  signal input hash;
  signal input ciphertext[nBalls][4];
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];
  signal input privateKey;
  signal input randomness[nOthers][nBalls];
  signal input nActualPlayers;

  signal output out;

  component share;
  component balls;

  share = Share(nPlayers, nBalls);
  share.hash <== hash;
  share.ciphertext <== ciphertext;
  share.publicKey <== publicKey;
  share.publicKeys <== publicKeys;
  share.privateKey <== privateKey;
  share.randomness <== randomness;
  share.nActualPlayers <== nActualPlayers;

  balls = BingoBallHashes(nPlayers, nBalls);
  balls.partials <== share.out;

  out <== balls.out;
}
