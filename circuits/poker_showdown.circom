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
include "./showdown_seal.circom";

template PokerHashMain(nPlayers, nPots, nTotalCards) {
  var nOthers = nPlayers - 1;
  
  signal input potMasks[nPots];
  signal input publicKeys[nPlayers][2];
  signal input playerIndex;
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input sealCommitment;

  signal output out;

  component h1;
  component h2;
  component _h3[nPlayers];
  component h3;
  component finalHash;

  h1 = parallel Poseidon(nPots);
  h1.inputs <== potMasks;

  h2 = parallel HashPublicKeys(nPlayers);
  h2.publicKeys <== publicKeys;

  h3 = parallel Poseidon(nPlayers);

  for (var p = 0; p < nPlayers; p++) {
    _h3[p] = parallel HashCiphertexts(nTotalCards);
    if (p == 0) {
      _h3[p].ciphertext <== ciphertextCards;
    } else {
      _h3[p].ciphertext <== ciphertextPartials[p-1];
    }
  }
  for (var p = 0; p < nPlayers; p++) {
    h3.inputs[p] <== _h3[p].out;
  }

  finalHash = Poseidon(5);
  finalHash.inputs <== [
    h1.out,
    playerIndex,
    h2.out,
    h3.out,
    sealCommitment
  ];

  out <== finalHash.out;
}

template PokerVerifyDecryptedCards(nPlayers, nTotalCards) {
  assert(nPlayers > 1 && nPlayers < 11);

  signal input plaintextCards[nTotalCards];
  // Bits of potMasks[0], split once by Showdown.
  signal input maskBits[10];
  signal input decryptedCards[nTotalCards][2];

  signal output plaintextHoleCards[nPlayers][2];
  signal output plaintextSharedCards[5];

  component deck;
  component isEqual[nTotalCards][2];

  deck = parallel InstantiateDeck(nTotalCards, 1, 52);
  deck.cards <== plaintextCards;

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
    var playerInPot = maskBits[p];

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
  signal input potMaskBits[nPots][10];
  signal input plaintextHoleCards[nPlayers][2];
  signal input plaintextSharedCards[5];

  signal totalPlayers[nPots];
  signal maxInPot[nPots];
  
  signal output winnerMasks[nPots];
  
  component compare[nPots];
  component isZero[nPots];
  component firstPotGtOne;
  
  // Poker side pot logic: each subsequent pot must have strictly fewer players
  // than the previous pot (since at least one player must go all-in to create a side pot)
  // Compute actual players in each pot first

  for (var i = 0; i < nPots; i++) {
    var count = 0;
    for (var p = 0; p < nPlayers; p++) {
      count += potMaskBits[i][p];
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
    compare[i] = parallel CompareHands(nPlayers);
    compare[i].mask <== potMasks[i];
    compare[i].maskBits <== potMaskBits[i];
    compare[i].maxInPot <== maxInPot[i];
    compare[i].playerCards <== plaintextHoleCards;
    compare[i].sharedCards <== plaintextSharedCards;
  }
  for (var i = 0; i < nPots; i++) {
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
  signal input sealCommitment;

  // Non-hashed private inputs
  signal input privateKey;
  signal input publicKey[2];  // Prover's public key [x, y]
  signal input plaintextCards[nTotalCards];  // Claimed plaintext card values (0-51)

  signal potMaskBits[nPots][10];

  signal output out[nPots];

  component publicKeyCheck;
  component verifyKey;
  component hashMain;
  component potBits[nPots];
  component decryptPartials;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component compareHandsN;


  // Step 1: Extract publicKeys[playerIndex] and verify it matches publicKey
  publicKeyCheck = parallel PublicKeyCheck(nPlayers);
  publicKeyCheck.publicKeys <== publicKeys;
  publicKeyCheck.playerIndex <== playerIndex;
  publicKeyCheck.publicKey <== publicKey;

  // Step 2: Verify own private key matches own public key
  verifyKey = parallel VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  // Compute and verify hash
  hashMain = parallel PokerHashMain(nPlayers, nPots, nTotalCards);
  hashMain.potMasks <== potMasks;
  hashMain.publicKeys <== publicKeys;
  hashMain.playerIndex <== playerIndex;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.sealCommitment <== sealCommitment;
  
  hash === hashMain.out;

  for (var i = 0; i < nPots; i++) {
    potBits[i] = Num2Bits(10);
    potBits[i].in <== potMasks[i];
    for (var p = nPlayers; p < 10; p++) {
      potBits[i].out[p] === 0;
    }
    potMaskBits[i] <== potBits[i].out;
  }

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
  verifyDecryptedCards.maskBits <== potMaskBits[0];
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;
  
  // Step 7: Compare hands to determine winners
  compareHandsN = CompareHandsN(nPlayers, nPots);
  compareHandsN.potMasks <== potMasks;
  compareHandsN.potMaskBits <== potMaskBits;
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
  signal input sealCommitment;

  // Non-hashed Private inputs
  signal input privateKey;
  signal input publicKey[2];
  signal input plaintextCards[nTotalCards];
  signal input coefficients[2];

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
  showdown.sealCommitment <== sealCommitment;

  // Each winner mask is 10 bits. 1024^i places all nine into one coefficient.
  // The second limb stays 0.
  signal place[nPots];
  signal weighted[nPots];
  signal packedAcc[nPots];
  place[0] <== 1;
  weighted[0] <== showdown.out[0];
  packedAcc[0] <== weighted[0];
  for (var i = 1; i < nPots; i++) {
    place[i] <== place[i - 1] * 1024;
    weighted[i] <== showdown.out[i] * place[i];
    packedAcc[i] <== packedAcc[i - 1] + weighted[i];
  }

  hashOut = SealedShowdownHash(2);
  hashOut.sealCommitment <== sealCommitment;
  hashOut.results <== [packedAcc[nPots - 1], 0];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
}
