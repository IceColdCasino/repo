/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/bitify.circom";
include "./hash.circom";
include "./elgamal.circom";
include "./actual_players.circom";

// Poseidon(ciphertext hash, card mask, public-key hash).
template HashMain(nOthers, nCards) {
  var nPlayers = nOthers + 1;

  signal input ciphertext[nCards][4];
  signal input cardMask;
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  signal allPublicKeys[nPlayers][2];
  signal output out;

  component hashCiphertexts = parallel HashCiphertexts(nCards);
  component hashPublicKeys = parallel HashPublicKeys(nPlayers);
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
  component encrypt[nOthers][nCards];
  signal use[nOthers][nCards];
  signal plainX[nOthers][nCards];
  signal plainY[nOthers][nCards];

  cardMaskBits = Num2Bits(25);
  cardMaskBits.in <== cardMask;
  for (var i = nCards; i < 25; i++) {
    cardMaskBits.out[i] === 0;
  }

  for (var i = 0; i < nCards; i++) {
    partialDecrypt[i] = parallel PartialDecrypt();
    partialDecrypt[i].c0 <== [ciphertext[i][0], ciphertext[i][1]];
    partialDecrypt[i].privateKey <== privateKey;
  }

  for (var i = 0; i < nCards; i++) {
    for (var j = 0; j < nOthers; j++) {
      // A masked card encrypts the identity point under the recipient key.
      use[j][i] <== cardMaskBits.out[i];
      plainX[j][i] <== use[j][i] * partialDecrypt[i].partial[0];
      plainY[j][i] <== use[j][i] * partialDecrypt[i].partial[1] + (1 - use[j][i]);

      encrypt[j][i] = parallel Encrypt();
      encrypt[j][i].plaintext <== [plainX[j][i], plainY[j][i]];
      encrypt[j][i].publicKey <== publicKeys[j];
      encrypt[j][i].randomness <== randomness[j][i];
    }
  }

  for (var i = 0; i < nCards; i++) {
    for (var j = 0; j < nOthers; j++) {
      out[j][i] <== encrypt[j][i].ciphertext;
    }
  }
}

// Recipient-major 4-limb columns for one card set.
template HashCardSet(nOthers, nSet) {
  signal input in[nOthers][nSet][4];
  signal output out;

  component hash = HashFlat(nOthers * nSet * 4);
  var t = 0;
  for (var i = 0; i < nOthers; i++) {
    for (var j = 0; j < nSet; j++) {
      for (var k = 0; k < 4; k++) {
        hash.in[t] <== in[i][j][k];
        t++;
      }
    }
  }
  out <== hash.out;
}

// Street hashes are internal. The only public output is
// Poseidon(2) of Poseidon(10 hole hashes) and Poseidon(flop, turn, river).
// On-chain Poseidon accepts at most 12 inputs, so the 13 streets are not hashed in one call.
// The chain recomputes the street hashes from the partials and checks that fold.
template PokerStreetHashes(nPlayers) {
  var nOthers = nPlayers - 1;
  var nCards = 2 * nPlayers + 5;
  var nStreets = nPlayers + 3;
  assert(nPlayers <= 12);

  signal input partials[nOthers][nCards][4];
  signal street[nStreets];
  signal output out;

  component holes[nPlayers];
  component flop;
  component turn;
  component river;
  component holeGroup;
  component boardGroup;
  component finalHash;

  for (var p = 0; p < nPlayers; p++) {
    holes[p] = parallel HashCardSet(nOthers, 2);
    for (var i = 0; i < nOthers; i++) {
      for (var k = 0; k < 4; k++) {
        holes[p].in[i][0][k] <== partials[i][2 * p][k];
        holes[p].in[i][1][k] <== partials[i][2 * p + 1][k];
      }
    }
  }

  flop = parallel HashCardSet(nOthers, 3);
  turn = parallel HashCardSet(nOthers, 1);
  river = parallel HashCardSet(nOthers, 1);
  var board = 2 * nPlayers;
  for (var i = 0; i < nOthers; i++) {
    for (var k = 0; k < 4; k++) {
      flop.in[i][0][k] <== partials[i][board][k];
      flop.in[i][1][k] <== partials[i][board + 1][k];
      flop.in[i][2][k] <== partials[i][board + 2][k];
      turn.in[i][0][k] <== partials[i][board + 3][k];
      river.in[i][0][k] <== partials[i][board + 4][k];
    }
  }
  for (var p = 0; p < nPlayers; p++) {
    street[p] <== holes[p].out;
  }
  street[nPlayers] <== flop.out;
  street[nPlayers + 1] <== turn.out;
  street[nPlayers + 2] <== river.out;

  holeGroup = parallel Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    holeGroup.inputs[p] <== street[p];
  }
  boardGroup = parallel Poseidon(3);
  boardGroup.inputs[0] <== street[nPlayers];
  boardGroup.inputs[1] <== street[nPlayers + 1];
  boardGroup.inputs[2] <== street[nPlayers + 2];
  finalHash = Poseidon(2);
  finalHash.inputs[0] <== holeGroup.out;
  finalHash.inputs[1] <== boardGroup.out;
  out <== finalHash.out;
}

template Share(nPlayers) {
  var nOthers = nPlayers - 1;
  var nCards = 2 * nPlayers + 5;

  signal input hash;

  signal input ciphertext[nCards][4];
  signal input cardMask;
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

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

  signal input hash;

  signal input ciphertext[nCards][4];
  signal input cardMask;
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  signal input privateKey;
  signal input randomness[nOthers][nCards];
  signal input nActualPlayers;

  signal output out;

  component share;
  component streets;

  share = Share(nPlayers);
  share.hash <== hash;
  share.ciphertext <== ciphertext;
  share.cardMask <== cardMask;
  share.publicKey <== publicKey;
  share.publicKeys <== publicKeys;
  share.nActualPlayers <== nActualPlayers;
  share.privateKey <== privateKey;
  share.randomness <== randomness;

  streets = PokerStreetHashes(nPlayers);
  streets.partials <== share.out;

  out <== streets.out;
}
