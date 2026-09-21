/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./hash.circom";
include "./elgamal.circom";
include "./polynomial_hash.circom";
include "circuits/comparators.circom";

template HashMain(nOthers, nCards) {
  var nPlayers = nOthers + 1;

  signal input ciphertext[nCards][4];
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  signal allPublicKeys[nPlayers][2];

  signal output out;

  component hashCiphertexts;
  component hashPublicKeys;
  component finalHash;

  allPublicKeys[0] <== publicKey;
  for (var i = 0; i < nOthers; i++) {
    allPublicKeys[i+1] <== publicKeys[i];
  }

  hashCiphertexts = HashCiphertexts(nCards);
  hashCiphertexts.ciphertext <== ciphertext;

  hashPublicKeys = HashPublicKeys(nPlayers);
  hashPublicKeys.publicKeys <== allPublicKeys;

  finalHash = Poseidon(2);
  finalHash.inputs <== [
    hashCiphertexts.out,
    hashPublicKeys.out
  ];

  out <== finalHash.out;
}

template CreatePartials(nOthers, nCards) {
  signal input ciphertext[nCards][4];
  signal input privateKey;
  signal input publicKeys[nOthers][2];
  signal input randomness[nOthers][nCards];

  signal output out[nOthers][nCards][4];

  component partialDecrypt[nCards];
  component encrypt[nOthers][nCards];

  for (var i = 0; i < nCards; i++) {
    partialDecrypt[i] = parallel PartialDecrypt();
    partialDecrypt[i].c0 <== [ciphertext[i][0], ciphertext[i][1]];
    partialDecrypt[i].privateKey <== privateKey;

    for (var j = 0; j < nOthers; j++) {
      encrypt[j][i] = parallel Encrypt();
      encrypt[j][i].plaintext <== partialDecrypt[i].partial;
      encrypt[j][i].publicKey <== publicKeys[j];
      encrypt[j][i].randomness <== randomness[j][i];
      out[j][i] <== encrypt[j][i].ciphertext;
    }
  }
}

template Share(nPlayers, nCards) {
  var nOthers = nPlayers - 1;

  signal input hash;

  // Hashed private inputs
  signal input ciphertext[nCards][4];
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  // Non-hashed private inputs
  signal input privateKey;
  signal input randomness[nOthers][nCards];
  signal input nActualPlayers;

  signal output out[nOthers][nCards][4];

  component verifyKey;
  component hashMain;
  component actualPlayersCheck;
  component createPartials;

  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = parallel HashMain(nOthers, nCards);
  hashMain.ciphertext <== ciphertext;
  hashMain.publicKey <== publicKey;
  hashMain.publicKeys <== publicKeys;
  hash === hashMain.out;

  actualPlayersCheck = parallel ActualPlayersCheck(nOthers);
  actualPlayersCheck.publicKeys <== publicKeys;
  actualPlayersCheck.nActualPlayers <== nActualPlayers;

  createPartials = parallel CreatePartials(nOthers, nCards);
  createPartials.ciphertext <== ciphertext;
  createPartials.privateKey <== privateKey;
  createPartials.publicKeys <== publicKeys;
  createPartials.randomness <== randomness;

  out <== createPartials.out;
}

template ShareHashOut(nPlayers, nCards) {
  var nOthers = nPlayers - 1;

  // Public input
  signal input hash;

  // Hashed private inputs
  signal input ciphertext[nCards][4];
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  // Non-hashed private inputs
  signal input privateKey;
  signal input randomness[nOthers][nCards];
  signal input nActualPlayers;

  signal output out;

  component share;
  component hashOut;

  share = Share(nPlayers, nCards);
  share.hash <== hash;
  share.ciphertext <== ciphertext;
  share.publicKey <== publicKey;
  share.publicKeys <== publicKeys;
  share.privateKey <== privateKey;
  share.randomness <== randomness;
  share.nActualPlayers <== nActualPlayers;

  hashOut = PolynomialHash(nPlayers, nCards);
  hashOut.in <== share.out;
  hashOut.nActualPlayers <== nActualPlayers;

  out <== hashOut.out;
}
