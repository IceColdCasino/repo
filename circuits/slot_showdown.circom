/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./partials.circom";
include "./showdown.circom";
include "./hash.circom";
include "./slot_eval.circom";
include "./slot_coin_bet.circom";

// One encrypted coin-bet (nActualBets = 1), sealed at share.
template SlotShowdownHashMain(nPlayers, nTotalCards) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBet[4];

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

  betHash = HashCiphertexts(1);
  betHash.ciphertext <== [ciphertextBet];

  finalHash = Poseidon(4);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    betHash.out
  ];

  out <== finalHash.out;
}

// One decrypted center stop per reel. Above/below are strip[(i±1) mod nStops].
template Showdown(nPlayers, nReels, nStops) {
  assert(nReels == 3 || nReels == 5);
  assert(nStops == 22);

  var nOthers = nPlayers - 1;
  var nTotalCards = nReels;

  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBet[4];

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];
  signal input coinBet;

  signal output payout;

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component decryptBet;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component verifyDecryptedBet;
  component handEval3;
  component handEval5;

  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  hashMain = SlotShowdownHashMain(nPlayers, nTotalCards);
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.ciphertextBet <== ciphertextBet;
  hash === hashMain.out;

  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  decryptBet = DecryptCoinBet();
  decryptBet.ciphertextBet <== ciphertextBet;
  decryptBet.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = VerifyDecryptedCards(nTotalCards, 1, nStops);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;

  verifyDecryptedBet = VerifyDecryptedCoinBet();
  verifyDecryptedBet.decryptedBet <== decryptBet.decryptedBet;
  verifyDecryptedBet.coinBet <== coinBet;

  if (nReels == 3) {
    handEval3 = EvaluateThreeReelStops();
    handEval3.centers <== plaintextCards;
    handEval3.coinBet <== coinBet;
    payout <== handEval3.payout;
  } else {
    handEval5 = EvaluateFiveReelStops();
    handEval5.centers <== plaintextCards;
    handEval5.coinBet <== coinBet;
    payout <== handEval5.payout;
  }
}

template ShowdownHashOut(nPlayers, nReels, nStops) {
  var nOthers = nPlayers - 1;
  var nTotalCards = nReels;

  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input ciphertextBet[4];

  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];
  signal input coinBet;
  signal input coefficients[1];

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers, nReels, nStops);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.playerIndex <== playerIndex;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.ciphertextBet <== ciphertextBet;
  showdown.privateKey <== privateKey;
  showdown.publicKey <== publicKey;
  showdown.plaintextCards <== plaintextCards;
  showdown.coinBet <== coinBet;

  hashOut = ShowdownPolynomialHash(1);
  hashOut.results <== [showdown.payout];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
