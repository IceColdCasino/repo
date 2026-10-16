/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./share.circom";

// Recipient-major partials for one baccarat street.
// Player and banker hands are two cards (11 × 2 × 4 = 88). Each third card is
// 11 × 4 = 44. HashFlat matches the host and the on-chain column check.
template HashBaccaratStreet(nOthers, nStreetCards) {
  signal input partials[nOthers][nStreetCards][4];
  signal output out;

  component hash = HashFlat(nOthers * nStreetCards * 4);
  var t = 0;
  for (var i = 0; i < nOthers; i++) {
    for (var c = 0; c < nStreetCards; c++) {
      for (var k = 0; k < 4; k++) {
        hash.in[t] <== partials[i][c][k];
        t++;
      }
    }
  }
  out <== hash.out;
}

// Streets: player hand, banker hand, player third, banker third.
// The public output is Poseidon(4) of those hashes. Four inputs fit on chain.
template BaccaratStreetHashes(nPlayers, nCards) {
  var nOthers = nPlayers - 1;
  assert(nCards == 6);

  signal input partials[nOthers][nCards][4];
  signal street[4];
  signal output out;

  component playerHand = parallel HashBaccaratStreet(nOthers, 2);
  component bankerHand = parallel HashBaccaratStreet(nOthers, 2);
  component playerThird = parallel HashBaccaratStreet(nOthers, 1);
  component bankerThird = parallel HashBaccaratStreet(nOthers, 1);
  component finalHash;

  for (var i = 0; i < nOthers; i++) {
    for (var k = 0; k < 4; k++) {
      playerHand.partials[i][0][k] <== partials[i][0][k];
      playerHand.partials[i][1][k] <== partials[i][1][k];
      bankerHand.partials[i][0][k] <== partials[i][2][k];
      bankerHand.partials[i][1][k] <== partials[i][3][k];
      playerThird.partials[i][0][k] <== partials[i][4][k];
      bankerThird.partials[i][0][k] <== partials[i][5][k];
    }
  }

  street[0] <== playerHand.out;
  street[1] <== bankerHand.out;
  street[2] <== playerThird.out;
  street[3] <== bankerThird.out;

  finalHash = Poseidon(4);
  finalHash.inputs[0] <== street[0];
  finalHash.inputs[1] <== street[1];
  finalHash.inputs[2] <== street[2];
  finalHash.inputs[3] <== street[3];
  out <== finalHash.out;
}

template BaccaratShareHashOut(nPlayers, nCards) {
  signal input hash;
  signal input ciphertext[nCards][4];
  signal input publicKey[2];
  signal input publicKeys[nPlayers - 1][2];
  signal input privateKey;
  signal input randomness[nPlayers - 1][nCards];
  signal input nActualPlayers;

  signal output out;

  component share;
  component streets;

  share = Share(nPlayers, nCards);
  share.hash <== hash;
  share.ciphertext <== ciphertext;
  share.publicKey <== publicKey;
  share.publicKeys <== publicKeys;
  share.privateKey <== privateKey;
  share.randomness <== randomness;
  share.nActualPlayers <== nActualPlayers;

  streets = BaccaratStreetHashes(nPlayers, nCards);
  streets.partials <== share.out;
  out <== streets.out;
}
