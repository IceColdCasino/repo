pub const SHOE_SIZE: usize = 6 * 52;

pub fn cardToRank(card_index: u32) u32 {
    return card_index % 13;
}

pub fn rankToHard(rank: u32) struct { value: u32, is_ace: bool } {
    if (rank == 12) return .{ .value = 1, .is_ace = true };
    if (rank >= 8) return .{ .value = 10, .is_ace = false };
    return .{ .value = rank + 2, .is_ace = false };
}

pub const HandValue = struct {
    best_value: u32,
    is_bust: u32,
    is_blackjack: u32,
    is_soft: u32,
};

pub fn computeHandValue(cards: []const u32, card_count: usize) HandValue {
    var hard: u32 = 0;
    var aces: u32 = 0;
    var i: usize = 0;
    while (i < card_count) : (i += 1) {
        const rh = rankToHard(cardToRank(cards[i]));
        hard += rh.value;
        if (rh.is_ace) aces += 1;
    }
    const soft = hard + 10;
    const soft_ok = aces > 0 and soft <= 21;
    const best = if (soft_ok) soft else hard;
    const bust: u32 = if (best > 21) 1 else 0;
    const bj: u32 = if (card_count == 2 and best == 21 and bust == 0) 1 else 0;
    return .{ .best_value = best, .is_bust = bust, .is_blackjack = bj, .is_soft = if (soft_ok) 1 else 0 };
}

/// 0=lose, 1=push, 2=win, 3=player natural
pub fn compareToDealer(player: HandValue, dealer: HandValue) u32 {
    if (player.is_bust == 1) return 0;
    if (player.is_blackjack == 1 and dealer.is_blackjack == 1) return 1;
    if (player.is_blackjack == 1 and dealer.is_blackjack == 0) return 3;
    if (dealer.is_blackjack == 1) return 0;
    if (dealer.is_bust == 1) return 2;
    if (player.best_value > dealer.best_value) return 2;
    if (player.best_value == dealer.best_value) return 1;
    return 0;
}

pub fn isPair(cards: []const u32, card_count: usize) bool {
    return card_count == 2 and cardToRank(cards[0]) == cardToRank(cards[1]);
}

pub fn actionStatus(cards: []const u32, card_count: usize, can_split: bool) u32 {
    const hand = computeHandValue(cards, card_count);
    if (hand.is_bust == 1) return 1;
    if (hand.best_value == 21) return 3;
    if (can_split and isPair(cards, card_count)) return 2;
    return 0;
}

pub fn dealerActionStatus(cards: []const u32, card_count: usize, hit_soft_17: bool) u32 {
    const hand = computeHandValue(cards, card_count);
    if (hand.is_blackjack == 1) return 2;
    if (hand.is_bust == 1) return 1;
    const soft17 = hand.is_soft == 1 and hand.best_value == 17;
    if (hand.best_value < 17 or (hit_soft_17 and soft17)) return 0;
    return 3;
}
