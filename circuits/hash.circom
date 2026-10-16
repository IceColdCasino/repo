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
  }
  for (var chunk = 0; chunk < actualChunks; chunk++) {
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

// Poseidon chunks of 12, then a tree of those digests.
// One chunk is wrapped in Poseidon(1), matching HashCiphertexts.
// nValues up to 1800 (poker: 9 recipients × 25 cards × 8 envelope limbs).
template HashFlat(nValues) {
  var CHUNK = 12;
  assert(nValues > 0 && nValues <= 1800);

  signal input in[nValues];
  signal output out;

  var n1 = (nValues + CHUNK - 1) \ CHUNK;
  component chunk[n1];
  signal h1[n1];

  for (var c = 0; c < n1; c++) {
    var sz = (c < n1 - 1) ? CHUNK : (nValues - c * CHUNK);
    chunk[c] = parallel Poseidon(sz);
    for (var j = 0; j < sz; j++) {
      chunk[c].inputs[j] <== in[c * CHUNK + j];
    }
  }
  for (var c = 0; c < n1; c++) {
    h1[c] <== chunk[c].out;
  }

  if (n1 == 1) {
    component wrap = Poseidon(1);
    wrap.inputs[0] <== h1[0];
    out <== wrap.out;
  } else if (n1 <= CHUNK) {
    component fin = Poseidon(n1);
    for (var i = 0; i < n1; i++) {
      fin.inputs[i] <== h1[i];
    }
    out <== fin.out;
  } else {
    var n2 = (n1 + CHUNK - 1) \ CHUNK;
    component chunk2[n2];
    signal h2[n2];
    for (var c = 0; c < n2; c++) {
      var sz2 = (c < n2 - 1) ? CHUNK : (n1 - c * CHUNK);
      chunk2[c] = parallel Poseidon(sz2);
      for (var j = 0; j < sz2; j++) {
        chunk2[c].inputs[j] <== h1[c * CHUNK + j];
      }
    }
    for (var c = 0; c < n2; c++) {
      h2[c] <== chunk2[c].out;
    }
    if (n2 <= CHUNK) {
      component fin2 = Poseidon(n2);
      for (var i = 0; i < n2; i++) {
        fin2.inputs[i] <== h2[i];
      }
      out <== fin2.out;
    } else {
      var n3 = (n2 + CHUNK - 1) \ CHUNK;
      assert(n3 <= CHUNK);
      component chunk3[n3];
      signal h3[n3];
      for (var c = 0; c < n3; c++) {
        var sz3 = (c < n3 - 1) ? CHUNK : (n2 - c * CHUNK);
        chunk3[c] = parallel Poseidon(sz3);
        for (var j = 0; j < sz3; j++) {
          chunk3[c].inputs[j] <== h2[c * CHUNK + j];
        }
      }
      for (var c = 0; c < n3; c++) {
        h3[c] <== chunk3[c].out;
      }
      component fin3 = Poseidon(n3);
      for (var i = 0; i < n3; i++) {
        fin3.inputs[i] <== h3[i];
      }
      out <== fin3.out;
    }
  }
}
