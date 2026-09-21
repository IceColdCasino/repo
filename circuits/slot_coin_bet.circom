/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./elgamal.circom";

// One coin-bet (1, 2, or 3). nActualBets is always 1.
// Kept out of slot_share.circom so showdown can include these without
// colliding with share.circom / showdown.circom `HashMain`.
template CommitCoinBet() {
  signal input coinBet;
  signal input publicKey[2];
  signal input randomness;

  signal output out[4];

  component is1;
  component is2;
  component is3;
  component babyPbk;
  component encrypt;

  is1 = IsEqual();
  is1.in <== [coinBet, 1];
  is2 = IsEqual();
  is2.in <== [coinBet, 2];
  is3 = IsEqual();
  is3.in <== [coinBet, 3];
  is1.out + is2.out + is3.out === 1;

  // coinBet ∈ {1,2,3} is already a valid BabyPbk scalar (never 0).
  babyPbk = BabyPbk();
  babyPbk.in <== coinBet;

  encrypt = Encrypt();
  encrypt.plaintext <== [babyPbk.Ax, babyPbk.Ay];
  encrypt.publicKey <== publicKey;
  encrypt.randomness <== randomness;

  out <== encrypt.ciphertext;
}

template DecryptCoinBet() {
  signal input ciphertextBet[4];
  signal input privateKey;

  signal output decryptedBet[2];

  component decrypt;

  decrypt = Decrypt();
  decrypt.ciphertext <== ciphertextBet;
  decrypt.privateKey <== privateKey;
  decryptedBet <== decrypt.plaintext;
}

template VerifyDecryptedCoinBet() {
  signal input decryptedBet[2];
  signal input coinBet;

  component babyPbk;
  component isEqual[2];

  babyPbk = BabyPbk();
  babyPbk.in <== coinBet;

  isEqual[0] = IsEqual();
  isEqual[1] = IsEqual();
  isEqual[0].in <== [decryptedBet[0], babyPbk.Ax];
  isEqual[1].in <== [decryptedBet[1], babyPbk.Ay];
  isEqual[0].out * isEqual[1].out === 1;
}
