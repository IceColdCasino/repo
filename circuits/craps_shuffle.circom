/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./shuffle.circom";

template CrapsShuffle(nPlayers, nDice, nFaces) {
  signal input hash;

  // Hashed private inputs
  signal input dice[nDice][nFaces][4];
  signal input publicKeys[nPlayers][2];

  // Non-hashed private inputs
  signal input permutationMatrix[nDice][nFaces][nFaces];
  signal input randomness[nDice][nFaces];

  // [0] Poseidon of the shuffled dice, [1] permutation-matrix hash.
  signal output out[2];

  component noFixedPointsCheck[nDice];
  component hashMain;
  component permute[nDice];
  component pkAggregator;
  component addRandomness[nDice];
  component permutationHasher;
  component deckHash;

  pkAggregator = parallel AggregatePublicKey(nPlayers);
  pkAggregator.publicKeys <== publicKeys;

  permutationHasher = parallel HashPermutationMatrixNIndependent(nDice, nFaces);
  permutationHasher.permutationMatrix <== permutationMatrix;

  hashMain = parallel HashMain(nPlayers, nDice * nFaces);
  hashMain.publicKeys <== publicKeys;

  for (var i = 0; i < nDice; i++) {
    noFixedPointsCheck[i] = parallel NoFixedPoints(nFaces);
    noFixedPointsCheck[i].permutationMatrix <== permutationMatrix[i];

    for (var j = 0; j < nFaces; j++) {
      hashMain.deck[i * nFaces + j] <== dice[i][j];
    }

    permute[i] = parallel ApplyPermutations(nFaces);
    permute[i].permutationMatrix <== permutationMatrix[i];
    permute[i].cards <== dice[i];
  }

  for (var i = 0; i < nDice; i++) {
    addRandomness[i] = parallel AddRandomnessN(nFaces);
    addRandomness[i].cards <== permute[i].out;
    addRandomness[i].publicKey <== pkAggregator.key;
    addRandomness[i].randomness <== randomness[i];
  }

  deckHash = parallel HashDeck(nDice * nFaces);
  for (var i = 0; i < nDice; i++) {
    for (var j = 0; j < nFaces; j++) {
      deckHash.deck[i * nFaces + j] <== addRandomness[i].out[j];
    }
  }

  hash === hashMain.out;

  out[0] <== deckHash.out;
  out[1] <== permutationHasher.out;
}