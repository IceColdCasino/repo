pub fn cardToRank(card_index: u32) u32 {
    return card_index % 13;
}

/// 0=player, 1=dealer, 2=tie
pub fn evaluate(cards: []const u32) u32 {
    const player = cardToRank(cards[0]);
    const dealer = cardToRank(cards[1]);
    if (player != dealer) return if (player > dealer) 0 else 1;
    const war_player = cardToRank(cards[2]);
    const war_dealer = cardToRank(cards[3]);
    if (war_player != war_dealer) return if (war_player > war_dealer) 0 else 1;
    return 2;
}
