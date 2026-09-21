/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./share.circom";
include "./slot_coin_bet.circom";

// Share reel stops and seal the single coin-bet to player + house.
template SlotShareHashOut(nPlayers, nReels) {
  assert(nPlayers == 2);
  assert(nReels == 3 || nReels == 5);

  var nOthers = nPlayers - 1;

  signal input hash;

  signal input ciphertext[nReels][4];
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];

  signal input privateKey;
  signal input cardRandomness[nOthers][nReels];
  signal input nActualPlayers;
  signal input coinBet;
  signal input betRandomness[nPlayers];

  signal output outHash;
  signal output encryptedBets[nPlayers][4];

  signal allPublicKeys[nPlayers][2];

  component shareHashOut;
  component commitBet[nPlayers];

  shareHashOut = parallel ShareHashOut(nPlayers, nReels);
  shareHashOut.hash <== hash;
  shareHashOut.ciphertext <== ciphertext;
  shareHashOut.publicKey <== publicKey;
  shareHashOut.publicKeys <== publicKeys;
  shareHashOut.privateKey <== privateKey;
  shareHashOut.randomness <== cardRandomness;
  shareHashOut.nActualPlayers <== nActualPlayers;

  outHash <== shareHashOut.out;

  allPublicKeys[0] <== publicKey;
  for (var p = 0; p < nOthers; p++) {
    allPublicKeys[p + 1] <== publicKeys[p];
  }

  for (var p = 0; p < nPlayers; p++) {
    commitBet[p] = parallel CommitCoinBet();
    commitBet[p].coinBet <== coinBet;
    commitBet[p].publicKey <== allPublicKeys[p];
    commitBet[p].randomness <== betRandomness[p];
    encryptedBets[p] <== commitBet[p].out;
  }
}
