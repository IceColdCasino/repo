/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./showdown_seal.circom";
include "./hash.circom";
include "./craps_eval.circom";
include "./craps_bet.circom";
include "./craps_bet_eval.circom";

template CrapsShowdownHashMain(nPlayers, nDice, nBets) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nDice][4];
  signal input ciphertextPartials[nOthers][nDice][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input phase;
  signal input point;
  signal input sealCommitment;

  signal output out;

  component h1;
  component _h2[nPlayers];
  component h2;
  component betHash;
  component tableBind;
  component finalHash;

  h1 = parallel HashPublicKeys(nPlayers);
  h1.publicKeys <== publicKeys;

  betHash = parallel HashCiphertexts(nBets);
  betHash.ciphertext <== ciphertextBets;

  h2 = parallel Poseidon(nPlayers);
  for (var p = 0; p < nPlayers; p++) {
    _h2[p] = parallel HashCiphertexts(nDice);
    if (p == 0) {
      _h2[p].ciphertext <== ciphertextCards;
    } else {
      _h2[p].ciphertext <== ciphertextPartials[p - 1];
    }
  }
  for (var p = 0; p < nPlayers; p++) {
    h2.inputs[p] <== _h2[p].out;
  }

  tableBind = parallel Poseidon(3);
  tableBind.inputs <== [nActualBets, phase, point];

  finalHash = Poseidon(6);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    betHash.out,
    tableBind.out,
    sealCommitment
  ];

  out <== finalHash.out;
}

template Showdown(nPlayers, nDice, nFaces, nBets) {
  assert(nBets >= 1 && nBets <= 12);

  var nOthers = nPlayers - 1;

  // Public input
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nDice][4];
  signal input ciphertextPartials[nOthers][nDice][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input phase;
  signal input point;
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nDice];
  signal input plaintextBets[nBets][2];

  // 12 bet multipliers, then table action and pointOut. The hash packs the
  // multipliers into one coefficient and action + pointOut * 6 into the other.
  signal output out[nBets + 2];

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptBets;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component verifyDecryptedBets;
  component tableEval;
  component betEval;

  phase * (phase - 1) === 0;

  publicKeyCheck = parallel PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = parallel CrapsShowdownHashMain(nPlayers, nDice, nBets);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextBets <== ciphertextBets;
  hashMain.nActualBets <== nActualBets;
  hashMain.phase <== phase;
  hashMain.point <== point;
  hashMain.sealCommitment <== sealCommitment;

  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nDice);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptBets = parallel DecryptBets(nBets);
  decryptBets.ciphertextBets <== ciphertextBets;
  decryptBets.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nDice);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  tableEval = parallel CrapsEval();
  tableEval.diceValues <== plaintextCards;
  tableEval.phase <== phase;
  tableEval.point <== point;

  betEval = parallel EvaluateCrapsBets(nBets);
  betEval.diceValues <== plaintextCards;
  betEval.phase <== phase;
  betEval.point <== point;
  betEval.in <== plaintextBets;
  betEval.nActualBets <== nActualBets;

  aggregatePartials = AggregatePartials(nPlayers, nDice);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = parallel VerifyDecryptedCards(nDice, 1, nFaces);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  verifyDecryptedBets = parallel VerifyDecryptedBets(nBets);
  verifyDecryptedBets.decryptedBets <== decryptBets.decryptedBets;
  verifyDecryptedBets.plaintextBets <== plaintextBets;

  for (var i = 0; i < nBets; i++) {
    out[i] <== betEval.out[i];
  }
  out[nBets] <== tableEval.action;
  out[nBets + 1] <== tableEval.pointOut;
}

template ShowdownHashOut(nPlayers, nDice, nFaces, nBets) {
  var nOthers = nPlayers - 1;

  // Poseidon of the hashed inputs, including the seal commitment.
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nDice][4];
  signal input ciphertextPartials[nOthers][nDice][4];
  signal input ciphertextBets[nBets][4];
  signal input nActualBets;
  signal input phase;
  signal input point;
  signal input sealCommitment;

  // Non-hashed private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nDice];
  signal input plaintextBets[nBets][2];
  signal input coefficients[2];

  signal tableTerm;
  signal place[nBets];
  signal weighted[nBets];
  signal packedAcc[nBets];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers, nDice, nFaces, nBets);
  showdown.hash <== hash;
  showdown.sealCommitment <== sealCommitment;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextBets <== ciphertextBets;
  showdown.nActualBets <== nActualBets;
  showdown.phase <== phase;
  showdown.point <== point;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCards <== plaintextCards;
  showdown.plaintextBets <== plaintextBets;

  // Action is 0..5 and pointOut is 0 or 4..10, so action + pointOut * 6
  // is the second coefficient. Each bet multiplier is below 1024, so
  // 1024^i places all 12 into the first coefficient.
  tableTerm <== showdown.out[nBets] + showdown.out[nBets + 1] * 6;

  place[0] <== 1;
  weighted[0] <== showdown.out[0];
  packedAcc[0] <== weighted[0];

  for (var i = 1; i < nBets; i++) {
    place[i] <== place[i - 1] * 1024;
    weighted[i] <== showdown.out[i] * place[i];
    packedAcc[i] <== packedAcc[i - 1] + weighted[i];
  }

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [packedAcc[nBets - 1], tableTerm];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
