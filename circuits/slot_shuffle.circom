/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./shuffle.circom";

template SlotShuffle(nReels, nStops) {
  var nPlayers = 2;
  
  assert(nReels == 3 || nReels == 5);
  assert(nStops >= 20);
  
  signal input hash;

  // Hashed private inputs
  signal input reels[nReels][nStops][4];
  signal input publicKeys[nPlayers][2];

  // Non-hashed private inputs
  signal input permutationMatrix[nReels][nStops][nStops];
  signal input randomness[nReels][nStops];

  signal output out[nReels][nStops][4];
  signal output permutationHash;

  component noFixedPointsCheck[nReels];
  component hashMain;
  component permute[nReels];
  component pkAggregator;
  component addRandomness[nReels];
  component permutationHasher;

  pkAggregator = parallel AggregatePublicKey(nPlayers);
  pkAggregator.publicKeys <== publicKeys;

  hashMain = parallel HashMain(nPlayers, nReels * nStops);
  hashMain.publicKeys <== publicKeys;

  permutationHasher = parallel HashPermutationMatrixNIndependent(nReels, nStops);
  permutationHasher.permutationMatrix <== permutationMatrix;

  for (var i = 0; i < nReels; i++) {
    noFixedPointsCheck[i] = parallel NoFixedPoints(nStops);
    noFixedPointsCheck[i].permutationMatrix <== permutationMatrix[i];

    for (var j = 0; j < nStops; j++) {
      hashMain.deck[i * nStops + j] <== reels[i][j];
    }

    permute[i] = parallel ApplyPermutations(nStops);
    permute[i].permutationMatrix <== permutationMatrix[i];
    permute[i].cards <== reels[i];

    addRandomness[i] = parallel AddRandomnessN(nStops);
    addRandomness[i].cards <== permute[i].out;
    addRandomness[i].publicKey <== pkAggregator.key;
    addRandomness[i].randomness <== randomness[i];

    out[i] <== addRandomness[i].out;
  }

  hash === hashMain.out;

  permutationHash <== permutationHasher.out;
}