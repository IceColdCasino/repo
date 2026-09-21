/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/bitify.circom";
include "circuits/mux1.circom";
include "./hash.circom";
include "./elgamal.circom";
include "./partials.circom";
include "./deck.circom";
include "./poker_compare_hands.circom";
include "./showdown.circom";

template PokerHashMain(nPlayers, nPots, nTotalCards) {
  var nOthers = nPlayers - 1;
  
  signal input potMasks[nPots];
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];

  signal output out;

  component h1;
  component h2;
  component _h3[nPlayers];
  component h3;
  component finalHash;

  h1 = Poseidon(nPots);
  h1.inputs <== potMasks;

  h2 = HashPublicKeys(nPlayers);
  h2.publicKeys <== publicKeys;

  h3 = Poseidon(nPlayers);

  for (var p = 0; p < nPlayers; p++) {
    _h3[p] = parallel HashCiphertexts(nTotalCards);
    if (p == 0) {
      _h3[p].ciphertext <== ciphertextCards;
    } else {
      _h3[p].ciphertext <== ciphertextPartials[p-1];
    }
    h3.inputs[p] <== _h3[p].out;
  }

  finalHash = Poseidon(4);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    h3.out
  ];

  out <== finalHash.out;
}

template PokerVerifyDecryptedCards(nPlayers, nTotalCards) {
  assert(nPlayers > 1 && nPlayers < 11);

  signal input plaintextCards[nTotalCards];
  signal input potMask;
  signal input decryptedCards[nTotalCards][2];

  signal output plaintextHoleCards[nPlayers][2];
  signal output plaintextSharedCards[5];

  component deck;
  component inPot;
  component isEqual[nTotalCards][2];

  deck = InstantiateDeck(nTotalCards, 1, 52);
  deck.cards <== plaintextCards;
  // Literal width (nPlayers < 11); unused high bits must be zero.
  inPot = Num2Bits(10);
  inPot.in <== potMask;
  for (var p = nPlayers; p < 10; p++) {
    inPot.out[p] === 0;
  }

  // First verify shared cards (always required to be valid)
  for (var s = 0; s < 5; s++) {
    var card = 2 * nPlayers + s;
    for (var i = 0; i < 2; i++) {
      isEqual[card][i] = IsEqual();
      isEqual[card][i].in <== [
        decryptedCards[card][i],
        deck.out[card][i]
      ];
    }
    // Shared cards must always be valid
    isEqual[card][0].out * isEqual[card][1].out === 1;

    plaintextSharedCards[s] <== plaintextCards[card];
  }
  
  // Then verify hole cards (must be valid if player is in pot)
  for (var p = 0; p < nPlayers; p++) {
    var playerInPot = inPot.out[p];

    for (var c = 0; c < 2; c++) {
      var card = 2 * p + c;
      for (var i = 0; i < 2; i++) {
        isEqual[card][i] = IsEqual();
        isEqual[card][i].in <== [
          decryptedCards[card][i],
          deck.out[card][i]
        ];
      }
      (1 - isEqual[card][0].out) * playerInPot === 0;
      (1 - isEqual[card][1].out) * playerInPot === 0;

      plaintextHoleCards[p][c] <== plaintextCards[card];
    }
  }
}

template CompareHandsN(nPlayers, nPots) {
  assert(nPlayers > 1 && nPlayers < 11);

  signal input potMasks[nPots];
  signal input plaintextHoleCards[nPlayers][2];
  signal input plaintextSharedCards[5];

  signal totalPlayers[nPots];
  signal maxInPot[nPots];
  
  signal output winnerMasks[nPots];
  
  component compare[nPots];
  component num2Bits[nPots];
  component isZero[nPots];
  component firstPotGtOne;
  
  // Poker side pot logic: each subsequent pot must have strictly fewer players
  // than the previous pot (since at least one player must go all-in to create a side pot)
  // Compute actual players in each pot first

  for (var i = 0; i < nPots; i++) {
    num2Bits[i] = Num2Bits(10);
    num2Bits[i].in <== potMasks[i];
    for (var p = nPlayers; p < 10; p++) {
      num2Bits[i].out[p] === 0;
    }

    var count = 0;
    for (var p = 0; p < nPlayers; p++) {
      count += num2Bits[i].out[p];
    }
    totalPlayers[i] <== count;
  }

  firstPotGtOne = ConstrainGt(4, 1);
  firstPotGtOne.in <== totalPlayers[0];
  
  // Now compute maxInPot for each pot based on previous pot's actual count
  // Pot 0: maxInPot = totalPlayers[0] (no constraint, but must be > 1 if not empty)
  // Pot i>0: 
  //   - If previous pot was empty (totalPlayers[i-1] == 0), this pot must also be empty (maxInPot = 0)
  //   - Otherwise, maxInPot = totalPlayers[i-1] - 1 (must have at most (previous - 1) players)
  
  maxInPot[0] <== totalPlayers[0];
  
  for (var i = 1; i < nPots; i++) {
    // Check if previous pot is empty
    isZero[i] = IsZero();
    isZero[i].in <== totalPlayers[i-1];
    
    // If previous pot is empty (isZero[i].out == 1), maxInPot = 0
    // Otherwise, maxInPot = totalPlayers[i-1] - 1
    // Using: maxInPot = (1 - isZero) * (totalPlayers[i-1] - 1)
    maxInPot[i] <== (1 - isZero[i].out) * (totalPlayers[i-1] - 1);
  }
  
  for (var i = 0; i < nPots; i++) {
    compare[i] = CompareHands(nPlayers);
    compare[i].mask <== potMasks[i];
    compare[i].maxInPot <== maxInPot[i];
    compare[i].playerCards <== plaintextHoleCards;
    compare[i].sharedCards <== plaintextSharedCards;
    
    winnerMasks[i] <== compare[i].winnerMask;
  }
}

template Showdown(nPlayers) {
  var nOthers = nPlayers - 1;
  var nPots = nPlayers - 1;
  var nTotalCards = nPlayers * 2 + 5;

  // Public input
  signal input hash;

  // Hashed Private inputs  
  signal input publicKeys[nPlayers][2];  // Full BabyJub public keys [x,y]
  signal input playerIndex;  // Index of this player (0 to nPlayers-1)
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];  // Encrypted partials from other players [c0.x, c0.y, c1.x, c1.y]
  signal input potMasks[nPots];

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];  // Prover's public key [x, y]
  signal input plaintextCards[nTotalCards];  // Claimed plaintext card values (0-51)

  signal output out[nPots];

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component decryptPartials;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component compareHandsN;


  // Step 1: Extract publicKeys[playerIndex] and verify it matches publicKey
  publicKeyCheck = PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  // Step 2: Verify own private key matches own public key
  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  // Compute and verify hash
  hashMain = PokerHashMain(nPlayers, nPots, nTotalCards);
  hashMain.potMasks <== potMasks;
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  
  // Verify hash commitment
  hash === hashMain.out;
  
  // Step 3: Decrypt partials from other players
  // Each partial was encrypted to this player's public key by other players
  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  // Step 4: Create own partials for each card
  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;
  
  // Step 5: Aggregate partials for each card
  // sumD = ownPartial + sum(decryptedOtherPartials)
  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  // Step 6: Verify decrypted cards match plaintext and split for hand comparison
  verifyDecryptedCards = PokerVerifyDecryptedCards(nPlayers, nTotalCards);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.potMask <== potMasks[0];
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;
  
  // Step 7: Compare hands to determine winners
  compareHandsN = CompareHandsN(nPlayers, nPots);
  compareHandsN.potMasks <== potMasks;
  compareHandsN.plaintextHoleCards <== verifyDecryptedCards.plaintextHoleCards;
  compareHandsN.plaintextSharedCards <== verifyDecryptedCards.plaintextSharedCards;
  
  out <== compareHandsN.winnerMasks;
}

template ShowdownHashOut(nPlayers) {
  var nOthers = nPlayers - 1;
  var nPots = nPlayers - 1;
  var nTotalCards = nPlayers * 2 + 5;

  // Public input
  signal input hash;

  // Hashed Private inputs
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input potMasks[nPots];

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];
  signal input coefficients[nPots]; // Polynomial hash coefficients (random 128-bit values, sealed to player)

  signal output out;

  component showdown;
  component hashOut;

  showdown = Showdown(nPlayers);
  showdown.hash <== hash;
  showdown.publicKeys <== publicKeys;
  showdown.potMasks <== potMasks;
  showdown.ciphertextCards <== ciphertextCards;
  showdown.playerIndex <== playerIndex;
  showdown.publicKey <== publicKey;
  showdown.ciphertextPartials <== ciphertextPartials;
  showdown.privateKey <== privateKey;
  showdown.plaintextCards <== plaintextCards;

  hashOut = ShowdownPolynomialHash(nPots);
  hashOut.results <== showdown.out;
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
