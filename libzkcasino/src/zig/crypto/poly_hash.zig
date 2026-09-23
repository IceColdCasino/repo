const Fr = @import("fr.zig").Fr;
const coeffs = @import("hash_coeffs.zig");

pub fn extractAndCombine(value: Fr) Fr {
    const limbs = value.toNormal();
    const low = (@as(u128, limbs[1]) << 64) | limbs[0];
    const high126 = ((@as(u128, limbs[3]) << 64) | limbs[2]) & ((@as(u128, 1) << 126) - 1);

    var reversed: u128 = 0;
    var i: u7 = 0;
    while (i < 126) : (i += 1) {
        if ((high126 >> i) & 1 != 0) {
            reversed |= @as(u128, 1) << (125 - i);
        }
    }

    const combined = @as(u256, low) + 2 * @as(u256, reversed);
    return Fr.fromNormal(.{
        @truncate(combined),
        @truncate(combined >> 64),
        @truncate(combined >> 128),
        @truncate(combined >> 192),
    });
}

pub fn coeff(i: usize) Fr {
    return Fr.fromNormal(coeffs.HASH_COEFFS_900[i]);
}

pub fn hashValues(values: []const Fr, n_actual_players: ?u32, n_others: usize, n_cards: usize, max_players: u32, poker_mask: bool) Fr {
    var acc = Fr.zero();
    if (n_actual_players == null) {
        for (values, 0..) |v, i| {
            acc = acc.add(extractAndCombine(v).mul(coeff(i)));
        }
        return acc;
    }

    const n_players = n_actual_players.?;
    if (n_players < 2 or n_players > max_players) @panic("nActualPlayers out of range");

    var idx: usize = 0;
    var i: usize = 0;
    while (i < n_others) : (i += 1) {
        const recipient_active = i < n_players - 1;
        var j: usize = 0;
        while (j < n_cards) : (j += 1) {
            const card_active = if (poker_mask) (j >= 20 or j < 2 * n_players) else true;
            const active = recipient_active and card_active;
            var k: usize = 0;
            while (k < 4) : (k += 1) {
                if (active) {
                    acc = acc.add(extractAndCombine(values[idx]).mul(coeff(idx)));
                }
                idx += 1;
            }
        }
    }
    return acc;
}

pub fn hash900(values: []const Fr, n_actual_players: ?u32) Fr {
    if (values.len != 900) @panic("hash900 expects 900 values");
    return hashValues(values, n_actual_players, 9, 25, 10, true);
}

pub fn hashRecipientMajor(values: []const Fr, n_others: usize, n_cards: usize, max_players: u32, n_actual_players: ?u32) Fr {
    const expected = n_others * n_cards * 4;
    if (values.len != expected) @panic("hashRecipientMajor size");
    return hashValues(values, n_actual_players, n_others, n_cards, max_players, false);
}
