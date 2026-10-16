/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./showdown_seal.circom";
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
  }

  for (var i = 0; i < nBets; i++) {
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
  }

  for (var i = 0; i < nBets; i++) {
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
  signal input sealCommitment;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component betHash;
  component finalHash;

  h1 = parallel HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  betHash = parallel HashCiphertexts(nBets);
  betHash.ciphertext <== ciphertextBets;

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

  finalHash = Poseidon(6);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    betHash.out,
    nActualBets,
    sealCommitment
  ];

  out <== finalHash.out;
}

template Showdown(nPlayers, deckSize, nBets) {
  assert(deckSize == 37 || deckSize == 38);

  var nOthers = nPlayers - 1;
  var nTotalCards = 1;

  // Public input
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input sealCommitment;

  // Non-hashed Private inputs
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

  publicKeyCheck = parallel PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = parallel RouletteShowdownHashMain(nPlayers, nBets);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextBets <== ciphertextBets;
  hashMain.nActualBets <== nActualBets;

  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptBets = parallel DecryptBets(nBets);
  decryptBets.ciphertextBets <== ciphertextBets;
  decryptBets.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  betEval = parallel EvaluateBets(nBets, deckSize);
  betEval.winner <== plaintextCard;
  betEval.in <== plaintextBets;
  betEval.nActualBets <== nActualBets;

  hashMain.sealCommitment <== sealCommitment;
  hash === hashMain.out;

  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  // Card range validate-only; shuffle already constrained the wheel.
  verifyDecryptedCards = parallel VerifyDecryptedCards(nTotalCards, 1, 38);
  verifyDecryptedCards.plaintextCards <== [plaintextCard];
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  verifyDecryptedBets = parallel VerifyDecryptedBets(nBets);
  verifyDecryptedBets.decryptedBets <== decryptBets.decryptedBets;
  verifyDecryptedBets.plaintextBets <== plaintextBets;

  out <== betEval.out;
}

template ShowdownHashOut(nPlayers, deckSize, nBets) {
  var nOthers = nPlayers - 1;
  var nTotalCards = 1;

  // Poseidon of the hashed inputs, including the seal commitment.
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCard;
  signal input plaintextBets[nBets][2];
  signal input coefficients[2];

  signal place[nBets];
  signal weighted[nBets];
  signal packedAcc[nBets];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers, deckSize, nBets);
  showdown.hash <== hash;
  showdown.sealCommitment <== sealCommitment;
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

  // Each multiplier is 0..35. 36^i places all 12 into one coefficient.
  // The second limb stays 0.
  place[0] <== 1;
  weighted[0] <== showdown.out[0];
  packedAcc[0] <== weighted[0];

  for (var i = 1; i < nBets; i++) {
    place[i] <== place[i - 1] * 36;
    weighted[i] <== showdown.out[i] * place[i];
    packedAcc[i] <== packedAcc[i - 1] + weighted[i];
  }

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [packedAcc[nBets - 1], 0];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
