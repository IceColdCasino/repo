/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./elgamal.circom";

template Register() {
  signal input privateKey;
  signal input publicKey[2];

  signal output out[2];
  signal output padding[4];

  component verifyKey;
  component encrypt;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  encrypt = Encrypt();
  encrypt.plaintext <== [0, 1];
  encrypt.publicKey <== publicKey;
  encrypt.randomness <== 1;

  out <== publicKey;
  padding <== encrypt.ciphertext;
}
