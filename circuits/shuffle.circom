/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/poseidon.circom";
include "circuits/bitify.circom";
include "./hash.circom";
include "./elgamal.circom";

// Poseidon-hash a list of row values (bits2num outputs), chunking at 12 inputs.
template HashRowValueChunk(nRows) {
  signal input rowValues[nRows];
  signal output out;

  var CHUNK = 12;

  if (nRows <= CHUNK) {
    component finalHash = Poseidon(nRows);
    for (var i = 0; i < nRows; i++) {
      finalHash.inputs[i] <== rowValues[i];
    }
    out <== finalHash.out;
  } else {
    var nChunks = (nRows + 11) \ 12;
    component chunkHashes[nChunks];

    for (var i = 0; i < nChunks; i++) {
      var chunkSize = (i < nChunks - 1) ? CHUNK : (nRows - i * CHUNK);
      chunkHashes[i] = parallel Poseidon(chunkSize);
      for (var j = 0; j < chunkSize; j++) {
        chunkHashes[i].inputs[j] <== rowValues[i * CHUNK + j];
      }
    }

    if (nChunks <= CHUNK) {
      component finalHash = Poseidon(nChunks);
      for (var i = 0; i < nChunks; i++) {
        finalHash.inputs[i] <== chunkHashes[i].out;
      }
      out <== finalHash.out;
    } else {
      var nLevel2 = (nChunks + 11) \ 12;
      component level2[nLevel2];
      for (var c = 0; c < nLevel2; c++) {
        var l2Size = (c < nLevel2 - 1) ? CHUNK : (nChunks - c * CHUNK);
        level2[c] = parallel Poseidon(l2Size);
        for (var j = 0; j < l2Size; j++) {
          level2[c].inputs[j] <== chunkHashes[c * CHUNK + j].out;
        }
      }
      component finalHash2 = Poseidon(nLevel2);
      for (var i = 0; i < nLevel2; i++) {
        finalHash2.inputs[i] <== level2[i].out;
      }
      out <== finalHash2.out;
    }
  }
}

// Hash permutation matrix using bits2num and Poseidon.
// Each row is converted to a number, then all rows are hashed.
template HashPermutationMatrix(nCards) {
  signal input permutationMatrix[nCards][nCards];

  signal rowValues[nCards];
  signal rowAccumulator[nCards][nCards+1];

  signal output out;

  component rowHasher;

  for (var i = 0; i < nCards; i++) {
    rowAccumulator[i][0] <== 0;
    for (var j = 0; j < nCards; j++) {
      rowAccumulator[i][j+1] <== rowAccumulator[i][j] * 2 + permutationMatrix[i][j];
    }
    rowValues[i] <== rowAccumulator[i][nCards];
  }

  rowHasher = HashRowValueChunk(nCards);
  for (var i = 0; i < nCards; i++) {
    rowHasher.rowValues[i] <== rowValues[i];
  }
  out <== rowHasher.out;
}

// 6-deck shoe (312 cards): hash each deck's 52 row values separately,
// then Poseidon(6) over the six deck-level hashes.
template HashPermutationMatrixNDecks(nDecks, deckSize) {
  var nCards = nDecks * deckSize;

  signal input permutationMatrix[nCards][nCards];

  signal rowValues[nCards];
  signal rowAccumulator[nCards][nCards+1];

  signal output out;

  component deckHashes[nDecks];
  component finalHash = Poseidon(nDecks);

  for (var i = 0; i < nCards; i++) {
    rowAccumulator[i][0] <== 0;
    for (var j = 0; j < nCards; j++) {
      rowAccumulator[i][j+1] <== rowAccumulator[i][j] * 2 + permutationMatrix[i][j];
    }
    rowValues[i] <== rowAccumulator[i][nCards];
  }

  for (var d = 0; d < nDecks; d++) {
    deckHashes[d] = parallel HashRowValueChunk(deckSize);
    for (var r = 0; r < deckSize; r++) {
      deckHashes[d].rowValues[r] <== rowValues[d * deckSize + r];
    }
  }

  for (var d = 0; d < nDecks; d++) {
    finalHash.inputs[d] <== deckHashes[d].out;
  }

  out <== finalHash.out;
}

// Independent square permutations (slot reels): hash each nSize×nSize
// matrix, then Poseidon(nMatrices) over the per-matrix hashes.
// Unlike HashPermutationMatrixNDecks, this is not one big nMatrices*nSize
// permutation — each reel is shuffled on its own.
template HashPermutationMatrixNIndependent(nMatrices, nSize) {
  signal input permutationMatrix[nMatrices][nSize][nSize];
  signal output out;

  component matrixHashes[nMatrices];
  component finalHash = Poseidon(nMatrices);

  for (var i = 0; i < nMatrices; i++) {
    matrixHashes[i] = parallel HashPermutationMatrix(nSize);
    matrixHashes[i].permutationMatrix <== permutationMatrix[i];
    finalHash.inputs[i] <== matrixHashes[i].out;
  }

  out <== finalHash.out;
}

// Generic deck hash: row-major flatten, chunk at 12, hierarchical combine.
template HashDeck(nCards) {
  var CHUNK = 12;
  var totalValues = nCards * 4;
  var nChunks = (totalValues + 11) \ 12;
  
  signal input deck[nCards][4];

  signal flat[totalValues];

  signal output out;

  component chunkHashes[nChunks];

  for (var i = 0; i < nCards; i++) {
    for (var j = 0; j < 4; j++) {
      flat[i * 4 + j] <== deck[i][j];
    }
  }

  for (var c = 0; c < nChunks; c++) {
    var chunkSize = (c < nChunks - 1) ? CHUNK : (totalValues - c * CHUNK);
    chunkHashes[c] = parallel Poseidon(chunkSize);
    for (var j = 0; j < chunkSize; j++) {
      chunkHashes[c].inputs[j] <== flat[c * CHUNK + j];
    }
  }

  if (nChunks <= CHUNK) {
    component finalHash = Poseidon(nChunks);
    for (var i = 0; i < nChunks; i++) {
      finalHash.inputs[i] <== chunkHashes[i].out;
    }
    out <== finalHash.out;
  } else {
    var nLevel2 = (nChunks + 11) \ 12;
    component level2[nLevel2];
    for (var c = 0; c < nLevel2; c++) {
      var chunkSize = (c < nLevel2 - 1) ? CHUNK : (nChunks - c * CHUNK);
      level2[c] = parallel Poseidon(chunkSize);
      for (var j = 0; j < chunkSize; j++) {
        level2[c].inputs[j] <== chunkHashes[c * CHUNK + j].out;
      }
    }
    component finalHash = Poseidon(nLevel2);
    for (var i = 0; i < nLevel2; i++) {
      finalHash.inputs[i] <== level2[i].out;
    }
    out <== finalHash.out;
  }
}

template HashMain(nPlayers, nCards) {
  signal input deck[nCards][4];
  signal input publicKeys[nPlayers][2];

  signal output out;

  component deckHash;
  component pkHash;
  component finalHash;

  deckHash = parallel HashDeck(nCards);
  deckHash.deck <== deck;

  pkHash = parallel HashPublicKeys(nPlayers);
  pkHash.publicKeys <== publicKeys;

  finalHash = Poseidon(2);
  finalHash.inputs <== [
    deckHash.out,
    pkHash.out
  ];
  
  out <== finalHash.out;
}

template ApplyPermutations(nCards) {
  signal input permutationMatrix[nCards][nCards];
  signal input cards[nCards][4];

  signal rowSum[nCards][nCards+1];
  signal colSum[nCards][nCards+1];
  signal diff[nCards][nCards];
  signal accumulator[nCards][nCards+1][4];

  signal output out[nCards][4];

  for (var i = 0; i < nCards; i++) {
    rowSum[i][0] <== 0;
    for (var j = 0; j < nCards; j++) {
      rowSum[i][j+1] <== rowSum[i][j] + permutationMatrix[i][j];
    }
    rowSum[i][nCards] === 1;
  }
  
  for (var j = 0; j < nCards; j++) {
    colSum[j][0] <== 0;
    for (var i = 0; i < nCards; i++) {
      colSum[j][i+1] <== colSum[j][i] + permutationMatrix[i][j];
    }
    colSum[j][nCards] === 1;
  }

  for (var i = 0; i < nCards; i++) {
    for (var j = 0; j < nCards; j++) {
      diff[i][j] <== permutationMatrix[i][j] - 1;
      permutationMatrix[i][j] * diff[i][j] === 0;
    }
  }

  for (var i = 0; i < nCards; i++) {
    for (var k = 0; k < 4; k++) {
      accumulator[i][0][k] <== 0;
    }
    
    for (var j = 0; j < nCards; j++) {
      for (var k = 0; k < 4; k++) {
        accumulator[i][j+1][k] <== accumulator[i][j][k] + cards[j][k] * permutationMatrix[i][j];
      }
    }

    out[i] <== accumulator[i][nCards];
  }
}

// Constrain that NO card is in its original position (zero fixed points)
// This enforces a strict shuffle where every card must move
template NoFixedPoints(nCards) {
  signal input permutationMatrix[nCards][nCards];
  
  signal isFixedPoint[nCards];
  signal sumFixedPoints[nCards+1];
  
  // For each row, check if it's a fixed point (P[i][i] == 1)
  for (var i = 0; i < nCards; i++) {
    // P[i][i] == 1 means card i is in position i (fixed point)
    isFixedPoint[i] <== permutationMatrix[i][i];
  }

  // Sum up all fixed points
  sumFixedPoints[0] <== 0;
  for (var i = 0; i < nCards; i++) {
    sumFixedPoints[i+1] <== sumFixedPoints[i] + isFixedPoint[i];
  }
  
  // Constrain that there are ZERO fixed points (strict shuffle)
  // Every card must move from its original position
  sumFixedPoints[nCards] === 0;
}

template AddRandomnessN(nCards) {
  signal input cards[nCards][4];
  signal input randomness[nCards];
  signal input publicKey[2];

  signal output out[nCards][4];

  component addRandomness[nCards];

  for (var i = 0; i < nCards; i++) {
    addRandomness[i] = parallel AddRandomness();
    addRandomness[i].ciphertext <== cards[i];
    addRandomness[i].publicKey <== publicKey;
    addRandomness[i].randomness <== randomness[i];
    out[i] <== addRandomness[i].out;
  }
}

template Shuffle(nPlayers, nDecks, deckSize) {
  var nCards = nDecks * deckSize;

  signal input hash;

  // Hashed private inputs
  signal input deck[nCards][4];
  signal input publicKeys[nPlayers][2];

  // Non-hashed private inputs
  signal input permutationMatrix[nCards][nCards];
  signal input randomness[nCards];

  signal output out[nCards][4];
  signal output permutationHash;
  
  component noFixedPointsCheck;
  component hashMain;
  component permute;
  component pkAggregator;
  component addRandomness;
  component permutationHasherN;
  component permutationHasher;

  pkAggregator = parallel AggregatePublicKey(nPlayers);
  pkAggregator.publicKeys <== publicKeys;
  
  // Ensure NO card stays in its original position (strict shuffle)
  noFixedPointsCheck = parallel NoFixedPoints(nCards);
  noFixedPointsCheck.permutationMatrix <== permutationMatrix;
  
  hashMain = parallel HashMain(nPlayers, nCards);
  hashMain.deck <== deck;
  hashMain.publicKeys <== publicKeys;
  hash === hashMain.out;

  permute = parallel ApplyPermutations(nCards);
  permute.permutationMatrix <== permutationMatrix;
  permute.cards <== deck;

  addRandomness = parallel AddRandomnessN(nCards);
  addRandomness.cards <== permute.out;
  addRandomness.publicKey <== pkAggregator.key;
  addRandomness.randomness <== randomness;

  out <== addRandomness.out;

  // Compute permutation matrix hash
  if (nDecks > 1) {
    permutationHasherN = parallel HashPermutationMatrixNDecks(nDecks, deckSize);
    permutationHasherN.permutationMatrix <== permutationMatrix;
    permutationHash <== permutationHasherN.out;
  } else {
    permutationHasher = parallel HashPermutationMatrix(nCards);
    permutationHasher.permutationMatrix <== permutationMatrix;
    permutationHash <== permutationHasher.out;
  }
}
