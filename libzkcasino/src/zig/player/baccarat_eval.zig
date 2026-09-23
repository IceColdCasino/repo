const RANKS = [_]u8{ 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 0, 1 };

pub fn cardToRank(card: u32) u8 {
    return RANKS[card % 13];
}

fn mod10sum2(a: u8, b: u8) u8 {
    const sum = a + b;
    return if (sum >= 10) sum - 10 else sum;
}

/// 0=player, 1=dealer, 2=tie
pub fn evaluate(cards: []const u32) u32 {
    var values: [6]u8 = undefined;
    var i: usize = 0;
    while (i < 6) : (i += 1) values[i] = cardToRank(cards[i]);

    const player2 = mod10sum2(values[0], values[1]);
    const dealer2 = mod10sum2(values[2], values[3]);
    const player_natural = player2 > 7;
    const dealer_natural = dealer2 > 7;
    const natural = player_natural or dealer_natural;
    const player_draws = !natural and player2 <= 5;
    const player_stood = !natural and !player_draws;
    const dealer_when_stood = player_stood and dealer2 <= 5;
    const player_third = values[4];

    var dealer_after_draw = false;
    if (!natural and player_draws) {
        if (dealer2 <= 2) {
            dealer_after_draw = true;
        } else if (dealer2 == 3 and player_third != 8) {
            dealer_after_draw = true;
        } else if (dealer2 == 4 and player_third >= 2 and player_third <= 7) {
            dealer_after_draw = true;
        } else if (dealer2 == 5 and player_third >= 4 and player_third <= 7) {
            dealer_after_draw = true;
        } else if (dealer2 == 6 and player_third >= 6 and player_third <= 7) {
            dealer_after_draw = true;
        }
    }

    const dealer_draws = dealer_when_stood or dealer_after_draw;
    const dealer_third = if (player_draws) values[5] else values[4];
    var player_final = if (player_draws) mod10sum2(player2, values[4]) else player2;
    var dealer_final = if (dealer_draws) mod10sum2(dealer2, dealer_third) else dealer2;
    if (natural) {
        player_final = player2;
        dealer_final = dealer2;
    }
    if (player_final == dealer_final) return 2;
    return if (player_final > dealer_final) 0 else 1;
}
