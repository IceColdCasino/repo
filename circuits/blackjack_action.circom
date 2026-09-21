/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/comparators.circom";
include "circuits/gates.circom";
include "circuits/mux1.circom";
include "./helpers.circom";
include "./blackjack_showdown.circom";

// Shared player/dealer action Poseidon binding.
// canSplit is only meaningful when isDealer=0; hitSoft17 only when isDealer=1.
template BlackjackActionHashMain(nPlayers, nTotalCards) {
  var nOthers = nPlayers - 1;

  signal input publicKeys[nPlayers][2];
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input cardCount;
  signal input canSplit;
  signal input hitSoft17;
  signal input isDealer;

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

  finalHash = Poseidon(6);
  finalHash.inputs <== [
    h1.out,
    h2.out,
    cardCount,
    canSplit,
    hitSoft17,
    isDealer
  ];

  out <== finalHash.out;
}

// Player action: 0=can hit, 1=bust (skip showdown), 2=can split, 3=forced stand at 21.
template EvaluateActionHand(maxCards) {
  signal input cards[maxCards];
  signal input cardCount;
  signal input canSplit;

  signal isTwentyOne;
  signal terminal;
  signal splitCandidate;
  signal splitCandidate2;
  signal splitAllowed;

  signal output out;

  component hand;
  component eq21;
  component eq2;
  component rank0;
  component rank1;
  component eqRank;
  component muxSplit;
  component muxTwentyOne;
  component muxTerminal;

  hand = HandValue(maxCards);
  hand.cards <== cards;
  hand.cardCount <== cardCount;

  canSplit * (canSplit - 1) === 0;

  // Player action intentionally ignores soft/BJ flags (any 21 → stand status 3).
  hand.isSoft * (hand.isSoft - 1) === 0;
  hand.isBlackjack * (hand.isBlackjack - 1) === 0;

  eq21 = IsEqual();
  eq21.in <== [hand.bestValue, 21];

  isTwentyOne <== eq21.out * (1 - hand.isBust);

  terminal <== hand.isBust + isTwentyOne - hand.isBust * isTwentyOne;

  eq2 = IsEqual();
  eq2.in <== [cardCount, 2];

  rank0 = CardToRank(shoeSize());
  rank1 = CardToRank(shoeSize());
  rank0.card <== cards[0];
  rank1.card <== cards[1];

  eqRank = IsEqual();
  eqRank.in <== [rank0.rank, rank1.rank];

  splitCandidate <== canSplit * eq2.out;
  splitCandidate2 <== splitCandidate * eqRank.out;
  splitAllowed <== splitCandidate2 * (1 - terminal);

  muxSplit = Mux1();
  muxSplit.s <== splitAllowed;
  muxSplit.c[0] <== 0;
  muxSplit.c[1] <== 2;

  muxTwentyOne = Mux1();
  muxTwentyOne.s <== isTwentyOne;
  muxTwentyOne.c[0] <== 1;
  muxTwentyOne.c[1] <== 3;

  muxTerminal = Mux1();
  muxTerminal.s <== terminal;
  muxTerminal.c[0] <== muxSplit.out;
  muxTerminal.c[1] <== muxTwentyOne.out;

  out <== muxTerminal.out;
}

// Dealer action: 0=must hit, 1=bust, 2=natural blackjack, 3=must stand.
// hitSoft17: 0 = S17, 1 = H17.
template EvaluateDealerActionHand(maxCards) {
  signal input cards[maxCards];
  signal input cardCount;
  signal input hitSoft17;

  signal output out;

  signal isSoft17;
  signal hitSoft;
  signal below17OrSoftHit;
  signal mustHit;
  signal notBj;
  signal notBust;
  signal live;

  component hand;
  component eq17;
  component lt17;
  component muxHit;
  component muxBust;
  component muxBj;

  hand = HandValue(maxCards);
  hand.cards <== cards;
  hand.cardCount <== cardCount;

  hitSoft17 * (hitSoft17 - 1) === 0;

  eq17 = IsEqual();
  eq17.in <== [hand.bestValue, 17];

  isSoft17 <== hand.isSoft * eq17.out;
  hitSoft <== hitSoft17 * isSoft17;

  lt17 = LessThan(8);
  lt17.in[0] <== hand.bestValue;
  lt17.in[1] <== 17;

  below17OrSoftHit <== lt17.out + hitSoft - lt17.out * hitSoft;

  notBj <== 1 - hand.isBlackjack;
  notBust <== 1 - hand.isBust;
  live <== notBj * notBust;
  mustHit <== below17OrSoftHit * live;

  muxHit = Mux1();
  muxHit.s <== mustHit;
  muxHit.c[0] <== 3;
  muxHit.c[1] <== 0;

  muxBust = Mux1();
  muxBust.s <== hand.isBust;
  muxBust.c[0] <== muxHit.out;
  muxBust.c[1] <== 1;

  muxBj = Mux1();
  muxBj.s <== hand.isBlackjack;
  muxBj.c[0] <== muxBust.out;
  muxBj.c[1] <== 2;

  out <== muxBj.out;
}

// Unified player/dealer action. Card slots sized for dealer max (13).
// Public outputs (via ActionHashOut): status poly-hash and dealerUpIsAce.
template Action(nPlayers) {
  var nTotalCards = maxDealerCards();
  var nOthers = nPlayers - 1;

  signal input hash;

  signal input publicKey[2];
  signal input publicKeys[nPlayers][2];
  signal input ciphertextCards[nTotalCards][4];
  signal input ciphertextPartials[nOthers][nTotalCards][4];
  signal input cardCount;
  signal input canSplit;
  signal input hitSoft17;
  signal input isDealer;

  signal input privateKey;
  signal input plaintextCards[nTotalCards];

  signal output out;
  // Computed: Ace(upcard) when isDealer=1, else 0. Not a free witness.
  signal output dealerUpIsAce;

  component hashMain;
  component verifyKey;
  component decryptPartials;
  component createOwnPartials;
  component aggregatePartials;
  component verifyDecryptedCards;
  component playerEval;
  component dealerEval;
  component muxRole;
  component upRank;
  component eqAce;

  isDealer * (isDealer - 1) === 0;
  // Role-specific flags must be zero on the unused path.
  isDealer * canSplit === 0;
  (1 - isDealer) * hitSoft17 === 0;

  hashMain = BlackjackActionHashMain(nPlayers, nTotalCards);
  hashMain.publicKeys <== publicKeys;
  hashMain.ciphertextCards <== ciphertextCards;
  hashMain.ciphertextPartials <== ciphertextPartials;
  hashMain.cardCount <== cardCount;
  hashMain.canSplit <== canSplit;
  hashMain.hitSoft17 <== hitSoft17;
  hashMain.isDealer <== isDealer;
  hash === hashMain.out;

  verifyKey = VerifyKey();
  verifyKey.privateKey <== privateKey;
  verifyKey.publicKey <== publicKey;

  decryptPartials = parallel DecryptPartials(nPlayers, nTotalCards);
  decryptPartials.ciphertextPartials <== ciphertextPartials;
  decryptPartials.privateKey <== privateKey;

  createOwnPartials = parallel CreateOwnPartials(nTotalCards);
  createOwnPartials.ciphertextCards <== ciphertextCards;
  createOwnPartials.privateKey <== privateKey;

  aggregatePartials = AggregatePartials(nPlayers, nTotalCards);
  aggregatePartials.ownPartials <== createOwnPartials.ownPartials;
  aggregatePartials.otherPartials <== decryptPartials.partials;
  aggregatePartials.ciphertextCards <== ciphertextCards;

  verifyDecryptedCards = VerifyShoeDecryptedCards(nTotalCards);
  verifyDecryptedCards.plaintextCards <== plaintextCards;
  verifyDecryptedCards.decryptedCards <== aggregatePartials.decryptedCards;
  verifyDecryptedCards.nUsedCards <== cardCount;

  // Dealer upcard Ace flag from plaintext slot 0 (gated by isDealer).
  upRank = CardToRank(shoeSize());
  upRank.card <== plaintextCards[0];
  eqAce = IsEqual();
  eqAce.in <== [upRank.rank, 12];
  dealerUpIsAce <== isDealer * eqAce.out;

  playerEval = EvaluateActionHand(nTotalCards);
  playerEval.cards <== plaintextCards;
  playerEval.cardCount <== cardCount;
  playerEval.canSplit <== canSplit;

  dealerEval = EvaluateDealerActionHand(nTotalCards);
  dealerEval.cards <== plaintextCards;
  dealerEval.cardCount <== cardCount;
  dealerEval.hitSoft17 <== hitSoft17;

  muxRole = Mux1();
  muxRole.s <== isDealer;
  muxRole.c[0] <== playerEval.out;
  muxRole.c[1] <== dealerEval.out;

  out <== muxRole.out;
}

template ActionHashOut(nPlayers) {
  signal input hash;

  signal input publicKeys[nPlayers][2];
  signal input publicKey[2];
  signal input ciphertextCards[maxDealerCards()][4];
  signal input ciphertextPartials[nPlayers - 1][maxDealerCards()][4];
  signal input cardCount;
  signal input canSplit;
  signal input hitSoft17;
  signal input isDealer;

  signal input privateKey;
  signal input plaintextCards[maxDealerCards()];
  // coefficients[0]: status term (always random).
  // coefficients[1]: dealerUpIsAce term — random when isDealer=1, else 0.
  signal input coefficients[2];

  signal output out;
  signal output dealerUpIsAce;

  component action;
  component hashOut;

  action = Action(nPlayers);
  action.hash <== hash;
  action.publicKey <== publicKey;
  action.publicKeys <== publicKeys;
  action.ciphertextCards <== ciphertextCards;
  action.ciphertextPartials <== ciphertextPartials;
  action.cardCount <== cardCount;
  action.canSplit <== canSplit;
  action.hitSoft17 <== hitSoft17;
  action.isDealer <== isDealer;
  action.privateKey <== privateKey;
  action.plaintextCards <== plaintextCards;

  // Ace flag only mixes into the dealer action poly hash.
  (1 - isDealer) * coefficients[1] === 0;

  hashOut = ShowdownPolynomialHash(2);
  hashOut.results <== [action.out, action.dealerUpIsAce];
  hashOut.coefficients <== coefficients;

  out <== hashOut.out;
  dealerUpIsAce <== action.dealerUpIsAce;
}
