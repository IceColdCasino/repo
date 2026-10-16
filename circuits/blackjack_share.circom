/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./share.circom";

// All recipient partials for one card. 7 seats × 4 limbs = 28 field elements,
// hashed with the same 12-wide Poseidon chunks as HashFlat.
template HashOneCard(nOthers) {
  signal input in[nOthers][4];
  signal output out;

  component hash = HashFlat(nOthers * 4);
  var t = 0;
  for (var i = 0; i < nOthers; i++) {
    for (var k = 0; k < 4; k++) {
      hash.in[t] <== in[i][k];
      t++;
    }
  }
  out <== hash.out;
}

// Card hashes are internal. The only public output is Poseidon(2) of
// Poseidon(8) over cards 0..7 and Poseidon(8) over cards 8..15.
// On-chain Poseidon accepts at most 12 inputs, so the 16 card hashes are not
// hashed in one call. The chain recomputes a card hash from that card's
// partials. The initial deal gives each seat two cards, so one card of the
// pair can be opened without the other.
template BlackjackCardHashes(nPlayers, nCards) {
  var nOthers = nPlayers - 1;
  assert(nCards == 16);

  signal input partials[nOthers][nCards][4];
  signal card[nCards];
  signal output out;

  component hashes[nCards];
  component first;
  component rest;
  component finalHash;

  for (var c = 0; c < nCards; c++) {
    hashes[c] = parallel HashOneCard(nOthers);
    for (var i = 0; i < nOthers; i++) {
      for (var k = 0; k < 4; k++) {
        hashes[c].in[i][k] <== partials[i][c][k];
      }
    }
  }
  for (var c = 0; c < nCards; c++) {
    card[c] <== hashes[c].out;
  }

  first = parallel Poseidon(8);
  rest = parallel Poseidon(8);
  for (var c = 0; c < 8; c++) {
    first.inputs[c] <== card[c];
    rest.inputs[c] <== card[8 + c];
  }
  finalHash = Poseidon(2);
  finalHash.inputs[0] <== first.out;
  finalHash.inputs[1] <== rest.out;
  out <== finalHash.out;
}

template BlackjackShareHashOut(nPlayers, nCards) {
  var nOthers = nPlayers - 1;

  signal input hash;
  signal input ciphertext[nCards][4];
  signal input publicKey[2];
  signal input publicKeys[nOthers][2];
  signal input privateKey;
  signal input randomness[nOthers][nCards];
  signal input nActualPlayers;

  signal output out;

  component share;
  component cards;

  share = Share(nPlayers, nCards);
  share.hash <== hash;
  share.ciphertext <== ciphertext;
  share.publicKey <== publicKey;
  share.publicKeys <== publicKeys;
  share.privateKey <== privateKey;
  share.randomness <== randomness;
  share.nActualPlayers <== nActualPlayers;

  cards = BlackjackCardHashes(nPlayers, nCards);
  cards.partials <== share.out;

  out <== cards.out;
}
