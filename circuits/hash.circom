/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "circuits/poseidon.circom";

template HashCiphertexts(nCards) {
  var CHUNK = 12;
  var totalValues = nCards * 4;
  var maxChunks = 97;  // Maximum for 290 cards (blackjack showdown)

  signal input ciphertext[nCards][4];
  
  signal chunkOut[maxChunks];
  signal flat[totalValues];

  signal output out;

  component hashChunk[maxChunks];
  
  // Flatten ciphertext
  for (var i = 0; i < nCards; i++) {
    for (var j = 0; j < 4; j++) {
      flat[i * 4 + j] <== ciphertext[i][j];
    }
  }
  
  // chunks = ceil(totalValues / 12) = (totalValues + 11) / 12
  var actualChunks = (totalValues + 11) \ 12;
  
  // Hash in chunks
  for (var chunk = 0; chunk < actualChunks; chunk++) {
    var chunkSize = (chunk < actualChunks - 1) ? CHUNK : (totalValues - chunk * CHUNK);
    hashChunk[chunk] = parallel Poseidon(chunkSize);
    for (var j = 0; j < chunkSize; j++) {
      hashChunk[chunk].inputs[j] <== flat[chunk * CHUNK + j];
    }
    chunkOut[chunk] <== hashChunk[chunk].out;
  }
  
  // Final hash combining all chunks (hierarchical when > 12 chunks)
  if (actualChunks <= CHUNK) {
    component finalHash = Poseidon(actualChunks);
    for (var i = 0; i < actualChunks; i++) {
      finalHash.inputs[i] <== chunkOut[i];
    }
    out <== finalHash.out;
  } else {
    var nLevel2 = (actualChunks + 11) \ 12;
    component level2[nLevel2];
    for (var c = 0; c < nLevel2; c++) {
      var l2Size = (c < nLevel2 - 1) ? CHUNK : (actualChunks - c * CHUNK);
      level2[c] = parallel Poseidon(l2Size);
      for (var j = 0; j < l2Size; j++) {
        level2[c].inputs[j] <== chunkOut[c * CHUNK + j];
      }
    }
    component finalHash2 = Poseidon(nLevel2);
    for (var i = 0; i < nLevel2; i++) {
      finalHash2.inputs[i] <== level2[i].out;
    }
    out <== finalHash2.out;
  }
}

template HashPublicKeys(nPlayers) {
  assert(nPlayers <= 12);

  var split = nPlayers / 2;
  var chunkSize = split * 2;

  signal input publicKeys[nPlayers][2];
  
  signal output out;

  component hashChunk1 = parallel Poseidon(chunkSize);
  component hashChunk2 = parallel Poseidon(chunkSize);
  component finalHash = Poseidon(2);

  for (var i = 0; i < split; i++) {
    hashChunk1.inputs[i * 2] <== publicKeys[i][0];
    hashChunk1.inputs[i * 2 + 1] <== publicKeys[i][1];
    hashChunk2.inputs[i * 2] <== publicKeys[i + split][0];
    hashChunk2.inputs[i * 2 + 1] <== publicKeys[i + split][1];
  }

  finalHash.inputs[0] <== hashChunk1.out;
  finalHash.inputs[1] <== hashChunk2.out;
  out <== finalHash.out;
}
