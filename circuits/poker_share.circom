/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/mux1.circom";
include "circuits/bitify.circom";
include "./hash.circom";
include "./elgamal.circom";
include "./poker_polynomial_hash.circom";
include "circuits/comparators.circom";

/**
 * Mux2 template for selecting between two 2-element arrays
 * When s=0: out = c0
 * When s=1: out = c1
 */
template Mux2() {
  signal input c0[2];
  signal input c1[2];
  signal input s;

  signal output out[2];
  
  component mux[2];
  
  for (var i = 0; i < 2; i++) {
    mux[i] = Mux1();
    mux[i].c[0] <== c0[i];
    mux[i].c[1] <== c1[i];
    mux[i].s <== s;
    out[i] <== mux[i].out;
  }
}

template HashMain(nOthers, nCards) {
  var nPlayers = nOthers + 1;

  signal input ciphertext[nCards][4];
  signal input cardMask;
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  signal allPublicKeys[nPlayers][2];

  signal output out;

  component hashCiphertexts = HashCiphertexts(nCards);
  component hashPublicKeys = HashPublicKeys(nPlayers);
  component finalHash = Poseidon(3);

  allPublicKeys[0] <== publicKey;
  for (var i = 0; i < nOthers; i++) {
    allPublicKeys[i+1] <== publicKeys[i];
  }

  hashCiphertexts.ciphertext <== ciphertext;
  hashPublicKeys.publicKeys <== allPublicKeys;
  
  finalHash.inputs <== [
    hashCiphertexts.out,
    cardMask,
    hashPublicKeys.out
  ];
  
  out <== finalHash.out;
}

template CreatePartials(nOthers, nCards) {
  // Poker deal is at most 2*10 + 5 = 25 cards.
  assert(nCards > 0 && nCards <= 25);

  signal input cardMask;
  signal input ciphertext[nCards][4];
  signal input privateKey;
  signal input publicKeys[nOthers][2];
  signal input randomness[nOthers][nCards];

  signal output out[nOthers][nCards][4];

  component cardMaskBits;
  component partialDecrypt[nCards];
  component partialMux[nCards];
  component encrypt[nOthers][nCards];

  cardMaskBits = Num2Bits(25);
  cardMaskBits.in <== cardMask;
  for (var i = nCards; i < 25; i++) {
    cardMaskBits.out[i] === 0;
  }
  
  for (var i = 0; i < nCards; i++) {
    // Create the actual partial from ciphertext
    partialDecrypt[i] = parallel PartialDecrypt();
    partialDecrypt[i].c0 <== [ciphertext[i][0], ciphertext[i][1]];
    partialDecrypt[i].privateKey <== privateKey;
    
    // Use Mux2 to select between identity [0,1] and actual partial [x,y]
    // Based on bit i of cardMask
    partialMux[i] = Mux2();
    partialMux[i].s <== cardMaskBits.out[i];
    partialMux[i].c0 <== [0, 1];  // Identity
    partialMux[i].c1 <== partialDecrypt[i].partial;  // Actual partial

    // Encrypt masked partial for each recipient
    for (var j = 0; j < nOthers; j++) {
      encrypt[j][i] = parallel Encrypt();
      encrypt[j][i].plaintext <== partialMux[i].out;
      encrypt[j][i].publicKey <== publicKeys[j];
      encrypt[j][i].randomness <== randomness[j][i];
      out[j][i] <== encrypt[j][i].ciphertext;
    }
  }
}

template Share(nPlayers) {
  var nOthers = nPlayers - 1;
  var nCards = 2 * nPlayers + 5;
  
  // Public input
  signal input hash;
  
  // Hashed private inputs (nActualPlayers bound via PK identity, not Poseidon)
  signal input ciphertext[nCards][4];
  signal input cardMask;
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
  hashMain.cardMask <== cardMask;
  hashMain.publicKey <== publicKey;
  hashMain.publicKeys <== publicKeys;
  hash === hashMain.out;

  actualPlayersCheck = parallel ActualPlayersCheck(nOthers);
  actualPlayersCheck.publicKeys <== publicKeys;
  actualPlayersCheck.nActualPlayers <== nActualPlayers;

  createPartials = parallel CreatePartials(nOthers, nCards);
  createPartials.ciphertext <== ciphertext;
  createPartials.cardMask <== cardMask;
  createPartials.privateKey <== privateKey;
  createPartials.publicKeys <== publicKeys;
  createPartials.randomness <== randomness;

  out <== createPartials.out;
}

template ShareHashOut(nPlayers) {
  var nOthers = nPlayers - 1;
  var nCards = 2 * nPlayers + 5;
  
  // Public input
  signal input hash;
  
  // Hashed private inputs (nActualPlayers bound via PK identity, not Poseidon)
  signal input ciphertext[nCards][4];
  signal input cardMask;
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  // Non-hashed private inputs
  signal input privateKey;
  signal input randomness[nOthers][nCards];
  signal input nActualPlayers;

  signal output out;

  component share;
  component hashOut;

  share = Share(nPlayers);
  share.hash <== hash;
  share.ciphertext <== ciphertext;
  share.cardMask <== cardMask;
  share.publicKey <== publicKey;
  share.publicKeys <== publicKeys;
  share.nActualPlayers <== nActualPlayers;
  share.privateKey <== privateKey;
  share.randomness <== randomness;

  hashOut = PokerPolynomialHash(nPlayers);
  hashOut.in <== share.out;
  hashOut.nActualPlayers <== nActualPlayers;

  out <== hashOut.out;
}
