/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./roulette_eval.circom";
include "./roulette_bet.circom";
include "./hash.circom";

// Decrypt each packed bet (type||modifier) under the prover's key.
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

// Encoding check: BabyPbk(PackBet(type, modifier) + 1). Bounds enforced at share/commit.
template VerifyDecryptedBets(nBets) {
  signal input decryptedBets[nBets][2];
  signal input plaintextBets[nBets][2];

  component pack[nBets];
  component babyPbk[nBets];
  component isEqual[nBets][2];

  for (var i = 0; i < nBets; i++) {
    pack[i] = PackBet();
    pack[i].type <== plaintextBets[i][0];
    pack[i].modifier <== plaintextBets[i][1];

    babyPbk[i] = parallel BabyPbk();
    babyPbk[i].in <== pack[i].out + 1;

    for (var j = 0; j < 2; j++) {
      isEqual[i][j] = IsEqual();
    }
    isEqual[i][0].in <== [decryptedBets[i][0], babyPbk[i].Ax];
    isEqual[i][1].in <== [decryptedBets[i][1], babyPbk[i].Ay];
    isEqual[i][0].out * isEqual[i][1].out === 1;
  }
}

template RouletteShowdownHashMain(nPlayers, nBets) {
  var nOthers = nPlayers - 1;
  var nTotalCards = 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component betHash;
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

  // Hash sealed bets (one ciphertext per bet).
  betHash = HashCiphertexts(nBets);
  betHash.ciphertext <== ciphertextBets;

  finalHash = Poseidon(5);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    betHash.out,
    nActualBets
  ];

  out <== finalHash.out;
}

template Showdown(nPlayers, deckSize, nBets) {
  assert(deckSize == 37 || deckSize == 38);

  var nOthers = nPlayers - 1;
  var nTotalCards = 1;

  // Public input
  signal input hash;

  // Hashed private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;

  // Non-hashed private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCard;
  signal input plaintextBets[nBets][2];

  signal output out[nBets];

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptBets;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component verifyDecryptedBets;
  component betEval;

  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = RouletteShowdownHashMain(nPlayers, nBets);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextBets <== ciphertextBets;
  hashMain.nActualBets <== nActualBets;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptBets = parallel DecryptBets(nBets);
  decryptBets.ciphertextBets <== ciphertextBets;
  decryptBets.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  // Card range validate-only; shuffle already constrained the wheel.
  verifyDecryptedCards = VerifyDecryptedCards(nTotalCards, 1, 38);
  verifyDecryptedCards.plaintextCards <== [plaintextCard];
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  verifyDecryptedBets = VerifyDecryptedBets(nBets);
  verifyDecryptedBets.decryptedBets <== decryptBets.decryptedBets;
  verifyDecryptedBets.plaintextBets <== plaintextBets;

  betEval = EvaluateBets(nBets, deckSize);
  betEval.winner <== plaintextCard;
  betEval.in <== plaintextBets;
  betEval.nActualBets <== nActualBets;

  out <== betEval.out;
}

template ShowdownHashOut(nPlayers, deckSize, nBets) {
  var nOthers = nPlayers - 1;
  var nTotalCards = 1;

  // Public input
  signal input hash;

  // Hashed private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;

  // Non-hashed private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCard;
  signal input plaintextBets[nBets][2];
  signal input coefficients[nBets];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers, deckSize, nBets);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextBets <== ciphertextBets;
  showdown.nActualBets <== nActualBets;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCard <== plaintextCard;
  showdown.plaintextBets <== plaintextBets;

  hashOut = ShowdownPolynomialHash(nBets);
  hashOut.results <== showdown.out;
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
