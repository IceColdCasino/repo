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
// One permutation row, packed as an integer. Rows do not depend on each other.
template RowBitsToNum(nBits) {
  signal input bits[nBits];
  signal output out;

  signal acc[nBits+1];
  acc[0] <== 0;
  for (var j = 0; j < nBits; j++) {
    acc[j+1] <== acc[j] * 2 + bits[j];
  }
  out <== acc[nBits];
}

template HashPermutationMatrix(nCards) {
  signal input permutationMatrix[nCards][nCards];

  signal output out;

  component rows[nCards];
  component rowHasher;

  for (var i = 0; i < nCards; i++) {
    rows[i] = parallel RowBitsToNum(nCards);
    rows[i].bits <== permutationMatrix[i];
  }

  rowHasher = HashRowValueChunk(nCards);
  for (var i = 0; i < nCards; i++) {
    rowHasher.rowValues[i] <== rows[i].out;
  }
  out <== rowHasher.out;
}

// 6-deck shoe (312 cards): hash each deck's 52 row values separately,
// then Poseidon(6) over the six deck-level hashes.
template HashPermutationMatrixNDecks(nDecks, deckSize) {
  var nCards = nDecks * deckSize;

  signal input permutationMatrix[nCards][nCards];

  signal output out;

  component rows[nCards];
  component deckHashes[nDecks];
  component finalHash = Poseidon(nDecks);

  for (var i = 0; i < nCards; i++) {
    rows[i] = parallel RowBitsToNum(nCards);
    rows[i].bits <== permutationMatrix[i];
  }

  for (var d = 0; d < nDecks; d++) {
    deckHashes[d] = parallel HashRowValueChunk(deckSize);
    for (var r = 0; r < deckSize; r++) {
      deckHashes[d].rowValues[r] <== rows[d * deckSize + r].out;
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
  }
  for (var i = 0; i < nMatrices; i++) {
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

// Select one output card and check that its permutation row is a 0/1 vector
// summing to 1. Each row is independent of the others.
template PermuteOneRow(nCards) {
  signal input permutationRow[nCards];
  signal input cards[nCards][4];

  signal output out[4];

  signal rowSum[nCards+1];
  signal diff[nCards];
  signal accumulator[nCards+1][4];

  rowSum[0] <== 0;
  for (var j = 0; j < nCards; j++) {
    rowSum[j+1] <== rowSum[j] + permutationRow[j];
    diff[j] <== permutationRow[j] - 1;
    permutationRow[j] * diff[j] === 0;
  }
  rowSum[nCards] === 1;

  for (var k = 0; k < 4; k++) {
    accumulator[0][k] <== 0;
  }
  for (var j = 0; j < nCards; j++) {
    for (var k = 0; k < 4; k++) {
      accumulator[j+1][k] <== accumulator[j][k] + cards[j][k] * permutationRow[j];
    }
  }
  for (var k = 0; k < 4; k++) {
    out[k] <== accumulator[nCards][k];
  }
}

// A permutation column sums to 1. Independent of every other column.
template MatrixColumnSum(nCards) {
  signal input column[nCards];
  signal output total;

  signal acc[nCards+1];
  acc[0] <== 0;
  for (var i = 0; i < nCards; i++) {
    acc[i+1] <== acc[i] + column[i];
  }
  total <== acc[nCards];
  total === 1;
}

template ApplyPermutations(nCards) {
  signal input permutationMatrix[nCards][nCards];
  signal input cards[nCards][4];

  signal output out[nCards][4];

  component rows[nCards];
  component cols[nCards];

  for (var i = 0; i < nCards; i++) {
    rows[i] = parallel PermuteOneRow(nCards);
    rows[i].permutationRow <== permutationMatrix[i];
    rows[i].cards <== cards;
  }

  for (var j = 0; j < nCards; j++) {
    cols[j] = parallel MatrixColumnSum(nCards);
    for (var i = 0; i < nCards; i++) {
      cols[j].column[i] <== permutationMatrix[i][j];
    }
  }

  for (var i = 0; i < nCards; i++) {
    out[i] <== rows[i].out;
  }
  for (var j = 0; j < nCards; j++) {
    cols[j].total === 1;
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
  }
  for (var i = 0; i < nCards; i++) {
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

  // [0] Poseidon of the shuffled shoe, [1] permutation-matrix hash.
  signal output out[2];
  
  component noFixedPointsCheck;
  component hashMain;
  component permute;
  component pkAggregator;
  component addRandomness;
  component permutationHasherN;
  component permutationHasher;
  component deckHash;

  // These four reads are independent. Start all of them before joining any.
  pkAggregator = parallel AggregatePublicKey(nPlayers);
  pkAggregator.publicKeys <== publicKeys;

  noFixedPointsCheck = parallel NoFixedPoints(nCards);
  noFixedPointsCheck.permutationMatrix <== permutationMatrix;

  hashMain = parallel HashMain(nPlayers, nCards);
  hashMain.deck <== deck;
  hashMain.publicKeys <== publicKeys;

  permute = parallel ApplyPermutations(nCards);
  permute.permutationMatrix <== permutationMatrix;
  permute.cards <== deck;

  if (nDecks > 1) {
    permutationHasherN = parallel HashPermutationMatrixNDecks(nDecks, deckSize);
    permutationHasherN.permutationMatrix <== permutationMatrix;
  } else {
    permutationHasher = parallel HashPermutationMatrix(nCards);
    permutationHasher.permutationMatrix <== permutationMatrix;
  }

  hash === hashMain.out;

  addRandomness = parallel AddRandomnessN(nCards);
  addRandomness.cards <== permute.out;
  addRandomness.publicKey <== pkAggregator.key;
  addRandomness.randomness <== randomness;

  deckHash = parallel HashDeck(nCards);
  deckHash.deck <== addRandomness.out;

  out[0] <== deckHash.out;

  if (nDecks > 1) {
    out[1] <== permutationHasherN.out;
  } else {
    out[1] <== permutationHasher.out;
  }
}
