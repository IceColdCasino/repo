/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./hash.circom";
include "./deck.circom";
include "./helpers.circom";

template HashMain(nPlayers, nTotalCards) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component finalHash;

  h1 = HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  h2 = Poseidon(nPlayers);

  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nTotalCards);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
    h2.inputs[p] <== _h2[p].out;
  }

  finalHash = Poseidon(3);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out
  ];

  out <== finalHash.out;
}

template VerifyDecryptedCards(nTotalCards, shoeSize, deckSize) {
  signal input plaintextCards[nTotalCards];
  signal input decryptedCards[nTotalCards][2];

  component deck;
  component isEqual[nTotalCards][2];

  deck = InstantiateDeck(nTotalCards, shoeSize, deckSize);
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

  component lt[nTerms];

  // Polynomial hash: h = sum((result + 1) * coefficients[i])
  // Adding 1 prevents 0 multiplication which leaks information
  acc[0] <== 0;

  for (var i = 0; i < nTerms; i++) {
    lt[i] = ConstrainLt(252, 2 ** 129);
    lt[i].in <== coefficients[i];

    terms[i] <== (results[i] + 1) * coefficients[i];
    acc[i + 1] <== acc[i] + terms[i];
  }

  out <== acc[nTerms];
}
