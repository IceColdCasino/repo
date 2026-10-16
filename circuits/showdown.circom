/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/bitify.circom";
include "./hash.circom";
include "./deck.circom";
include "./helpers.circom";

// Canonical decomposition of a value below 2^n. `Num2Bits_strict` rejects a
// field alias. `n` is at most 253. Every bit at index `n` or higher is zero,
// so a 128-bit coefficient also has bits 252 and 253 clear. Bit 252 stays
// live only when `n` is 253, the widest width whose top bit is 252.
template Num2BitsStrict(n) {
  assert(n > 0 && n <= 253);
  signal input in;
  signal output out[n];

  component full = Num2Bits_strict();
  full.in <== in;
  for (var i = 0; i < n; i++) {
    out[i] <== full.out[i];
  }
  for (var i = n; i < 254; i++) {
    full.out[i] === 0;
  }
}

template HashMain(nPlayers, nTotalCards) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input sealCommitment;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component finalHash;

  h1 = parallel HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = parallel Poseidon(nPlayers);

  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nTotalCards);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
  }
  for (var p = 0; p < nPlayers; p++) {
    h2.inputs[p] <== _h2[p].out;
  }

  finalHash = Poseidon(4);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    sealCommitment
  ];

  out <== finalHash.out;
}

template VerifyDecryptedCards(nTotalCards, deckSize) {
  signal input plaintextCards[nTotalCards];
  signal input decryptedCards[nTotalCards][2];

  component deck;
  component isEqual[nTotalCards][2];

  deck = InstantiateDeck(nTotalCards, deckSize);
  deck.cards <== plaintextCards;

  for (var c = 0; c < nTotalCards; c++) {
    for (var i = 0; i < 2; i++) {
      isEqual[c][i] = IsEqual();
      isEqual[c][i].in <== [
        decryptedCards[c][i],
        deck.out[c][i]
      ];
    }

    isEqual[c][0].out * isEqual[c][1].out === 1;
  }
}

template ShowdownPolynomialHash(nTerms) {
  signal input results[nTerms];
  signal input coefficients[nTerms];

  signal acc[nTerms + 1];
  signal terms[nTerms];

  signal output out;

  // Polynomial hash: h = sum((result + 1) * coefficients[i])
  // Adding 1 prevents 0 multiplication which leaks information.
  // Range is the seal's single Num2BitsStrict(128) check.
  acc[0] <== 0;

  for (var i = 0; i < nTerms; i++) {
    terms[i] <== (results[i] + 1) * coefficients[i];
    acc[i + 1] <== acc[i] + terms[i];
  }

  out <== acc[nTerms];
}
