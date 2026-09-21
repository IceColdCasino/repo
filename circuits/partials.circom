/*
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
*/

pragma circom 2.2.2;

include "./elgamal.circom";

template DecryptPartials(nPlayers, nTotalCards) {
  signal input ciphertextPartials[nPlayers-1][nTotalCards][4];
  signal input privateKey;
  
  signal output partials[nPlayers-1][nTotalCards][2];
  
  component decrypt[nPlayers-1][nTotalCards];
  
  for (var p = 0; p < nPlayers - 1; p++) {
    for (var card = 0; card < nTotalCards; card++) {
      decrypt[p][card] = parallel Decrypt();
      decrypt[p][card].ciphertext <== ciphertextPartials[p][card];
      decrypt[p][card].privateKey <== privateKey;
      
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
    
    ownPartials[card] <== createOwnPartial[card].partial;
  }
}

template AggregatePartials(nPlayers, nTotalCards) {
  signal input ownPartials[nTotalCards][2];
  signal input otherPartials[nPlayers-1][nTotalCards][2];
  signal input ciphertextCards[nTotalCards][4];
  
  signal aggPartial[nTotalCards][nPlayers+1][2];
  signal sumD[nTotalCards][2];

  signal output decryptedCards[nTotalCards][2];
  
  component partialAdder[nTotalCards][nPlayers];
  component cardAdder[nTotalCards];
  
  for (var card = 0; card < nTotalCards; card++) {
    // Start with own partial
    aggPartial[card][0][0] <== ownPartials[card][0];
    aggPartial[card][0][1] <== ownPartials[card][1];
    
    // Add other partials one by one (sequential within a card)
    for (var p = 0; p < nPlayers - 1; p++) {
      partialAdder[card][p] = BabyAdd();
      partialAdder[card][p].x1 <== aggPartial[card][p][0];
      partialAdder[card][p].y1 <== aggPartial[card][p][1];
      partialAdder[card][p].x2 <== otherPartials[p][card][0];
      partialAdder[card][p].y2 <== otherPartials[p][card][1];
      aggPartial[card][p+1][0] <== partialAdder[card][p].xout;
      aggPartial[card][p+1][1] <== partialAdder[card][p].yout;
    }
    
    // Final aggregated partial for this card
    sumD[card][0] <== aggPartial[card][nPlayers-1][0];
    sumD[card][1] <== aggPartial[card][nPlayers-1][1];
    
    // Decrypt card using aggregated partial
    // M = c1 - sumD = c1 + (-sumD)
    // Where -sumD = [-x, y] (negate x-coordinate only)
    cardAdder[card] = BabyAdd();
    cardAdder[card].x1 <== 0 - sumD[card][0];  // Negate x
    cardAdder[card].y1 <== sumD[card][1];    // Keep y
    cardAdder[card].x2 <== ciphertextCards[card][2];  // c1.x
    cardAdder[card].y2 <== ciphertextCards[card][3];  // c1.y
    
    decryptedCards[card] <== [
      cardAdder[card].xout,
      cardAdder[card].yout
    ];
  }
}
