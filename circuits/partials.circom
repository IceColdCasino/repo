/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./elgamal.circom";

template DecryptPartials(nPlayers, nTotalCards) {
  signal input ciphertextPartials[nPlayers - 1][nTotalCards][4];
  signal input privateKey;

  signal output partials[nPlayers - 1][nTotalCards][2];

  component decrypt[nPlayers - 1][nTotalCards];

  for (var p = 0; p < nPlayers - 1; p++) {
    for (var card = 0; card < nTotalCards; card++) {
      decrypt[p][card] = parallel Decrypt();
      decrypt[p][card].ciphertext <== ciphertextPartials[p][card];
      decrypt[p][card].privateKey <== privateKey;
    }
  }

  for (var p = 0; p < nPlayers - 1; p++) {
    for (var card = 0; card < nTotalCards; card++) {
      partials[p][card] <== decrypt[p][card].plaintext;
    }
  }
}

template CreateOwnPartials(nTotalCards) {
  signal input ciphertextCards[nTotalCards][4];
  signal input privateKey;
  
  signal output ownPartials[nTotalCards][2];
  
  component createOwnPartial[nTotalCards];
  
  for (var card = 0; card < nTotalCards; card++) {
    createOwnPartial[card] = parallel PartialDecrypt();
    createOwnPartial[card].c0 <== [ciphertextCards[card][0], ciphertextCards[card][1]];
    createOwnPartial[card].privateKey <== privateKey;
  }

  for (var card = 0; card < nTotalCards; card++) {
    ownPartials[card] <== createOwnPartial[card].partial;
  }
}

template AggregateOneCard(nPlayers) {
  signal input ownPartial[2];
  signal input otherPartials[nPlayers-1][2];
  signal input ciphertext[4];

  signal output decrypted[2];

  signal aggPartial[nPlayers][2];

  component partialAdder[nPlayers - 1];
  component cardAdder;

  aggPartial[0] <== ownPartial;

  for (var p = 0; p < nPlayers - 1; p++) {
    partialAdder[p] = BabyAdd();
    partialAdder[p].x1 <== aggPartial[p][0];
    partialAdder[p].y1 <== aggPartial[p][1];
    partialAdder[p].x2 <== otherPartials[p][0];
    partialAdder[p].y2 <== otherPartials[p][1];
    aggPartial[p + 1][0] <== partialAdder[p].xout;
    aggPartial[p + 1][1] <== partialAdder[p].yout;
  }

  cardAdder = BabyAdd();
  cardAdder.x1 <== 0 - aggPartial[nPlayers - 1][0];
  cardAdder.y1 <== aggPartial[nPlayers - 1][1];
  cardAdder.x2 <== ciphertext[2];
  cardAdder.y2 <== ciphertext[3];

  decrypted[0] <== cardAdder.xout;
  decrypted[1] <== cardAdder.yout;
}

template AggregatePartials(nPlayers, nTotalCards) {
  signal input ownPartials[nTotalCards][2];
  signal input otherPartials[nPlayers-1][nTotalCards][2];
  signal input ciphertextCards[nTotalCards][4];
  
  signal output decryptedCards[nTotalCards][2];

  component cards[nTotalCards];

  for (var card = 0; card < nTotalCards; card++) {
    cards[card] = parallel AggregateOneCard(nPlayers);
    cards[card].ownPartial <== ownPartials[card];
    cards[card].ciphertext <== ciphertextCards[card];
    for (var p = 0; p < nPlayers - 1; p++) {
      cards[card].otherPartials[p] <== otherPartials[p][card];
    }
  }

  for (var card = 0; card < nTotalCards; card++) {
    decryptedCards[card] <== cards[card].decrypted;
  }
}
