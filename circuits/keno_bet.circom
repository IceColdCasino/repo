/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./bet.circom";
include "./hash.circom";

template CommitBet() {
  signal input plaintextBet;
  signal input publicKey[2];
  signal input randomness;

  signal output out[4];

  component constrainBet;
  component babyPbk;
  component encrypt;

  constrainBet = ConstrainLt(8, 80);
  constrainBet.in <== plaintextBet;

  babyPbk = BabyPbk();
  babyPbk.in <== plaintextBet + 1;

  encrypt = Encrypt();
  encrypt.plaintext <== [babyPbk.Ax, babyPbk.Ay];
  encrypt.publicKey <== publicKey;
  encrypt.randomness <== randomness;

  out <== encrypt.ciphertext;
}

template CommitBets(nPlayers, nBets) {
  assert(nPlayers >= 2 && nPlayers <= 12);
  assert(nBets >= 1 && nBets <= 20);

  signal input publicKeys[nPlayers][2];
  signal input nActualBets;
  signal input plaintextBets[nBets];
  signal input randomness[nPlayers][nBets];

  signal output out[nPlayers][nBets][4];

  component lt;
  component uniqueBets;
  component commitBet[nPlayers][nBets];

  lt = ConstrainLt(5, nBets + 1);
  lt.in <== nActualBets;

  uniqueBets = parallel UniqueActualScalarBets(nBets);
  uniqueBets.nActualBets <== nActualBets;
  uniqueBets.plaintextBets <== plaintextBets;

  for (var p = 0; p < nPlayers; p++) {
    for (var i = 0; i < nBets; i++) {
      commitBet[p][i] = parallel CommitBet();
      commitBet[p][i].plaintextBet <== plaintextBets[i];
      commitBet[p][i].publicKey <== publicKeys[p];
      commitBet[p][i].randomness <== randomness[p][i];

      out[p][i] <== commitBet[p][i].out;
    }
  }
}

template DecryptBets(nBets) {
  signal input ciphertextBets[nBets][4];
  signal input privateKey;

  signal output decryptedBets[nBets][2];

  component decrypt[nBets];

  for (var i = 0; i < nBets; i++) {
    decrypt[i] = parallel Decrypt();
    decrypt[i].ciphertext <== ciphertextBets[i];
    decrypt[i].privateKey <== privateKey;

    decryptedBets[i] <== decrypt[i].plaintext;
  }
}

template VerifyDecryptedBets(nBets) {
  signal input decryptedBets[nBets][2];
  signal input plaintextBets[nBets];

  component babyPbk[nBets];
  component isEqual[nBets][2];

  for (var i = 0; i < nBets; i++) {
    babyPbk[i] = parallel BabyPbk();
    babyPbk[i].in <== plaintextBets[i] + 1;

    for (var j = 0; j < 2; j++) {
      isEqual[i][j] = IsEqual();
    }
    isEqual[i][0].in <== [decryptedBets[i][0], babyPbk[i].Ax];
    isEqual[i][1].in <== [decryptedBets[i][1], babyPbk[i].Ay];
    isEqual[i][0].out * isEqual[i][1].out === 1;
  }
}

template KenoBet(nPlayers, nBets) {
  var nOthers = nPlayers - 1;

  signal input hash;

  // Hashed private inputs
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];
  signal input nActualBets;

  // Non-hashed private inputs
  signal input plaintextBets[nBets];
  signal input randomness[nPlayers][nBets];

  signal output out[nPlayers][nBets][4];

  signal allPublicKeys[nPlayers][2];

  component hashPublicKeys;
  component finalHash;
  component commitBets;

  allPublicKeys[0] <== publicKey;
  for (var i = 0; i < nOthers; i++) {
    allPublicKeys[i + 1] <== publicKeys[i];
  }

  hashPublicKeys = HashPublicKeys(nPlayers);
  hashPublicKeys.publicKeys <== allPublicKeys;

  finalHash = Poseidon(2);
  finalHash.inputs <== [hashPublicKeys.out, nActualBets];
  hash === finalHash.out;

  commitBets = CommitBets(nPlayers, nBets);
  commitBets.publicKeys <== allPublicKeys;
  commitBets.plaintextBets <== plaintextBets;
  commitBets.nActualBets <== nActualBets;
  commitBets.randomness <== randomness;

  out <== commitBets.out;
}
