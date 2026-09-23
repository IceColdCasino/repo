const RED = [_]u8{ 1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36 };
const BLACK = [_]u8{ 2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35 };

fn inSet(set: []const u8, n: u32) bool {
    for (set) |v| {
        if (v == n) return true;
    }
    return false;
}

fn splitLow(m: u32) u32 {
    if (m < 24) {
        const j = m % 12;
        const r = (m - j) / 12;
        return 3 * j + 1 + r;
    }
    const t = m - 24;
    const j = t % 11;
    const r = (t - j) / 11;
    return 3 * j + 1 + r;
}

fn splitHigh(m: u32) u32 {
    if (m < 24) {
        const j = m % 12;
        const r = (m - j) / 12;
        return 3 * j + 2 + r;
    }
    const t = m - 24;
    const j = t % 11;
    const r = (t - j) / 11;
    return 3 * j + 4 + r;
}

fn cornerHas(m: u32, winner: u32) bool {
    const j = m % 11;
    const r = (m - j) / 11;
    const p = [_]u32{ 3 * j + 1 + r, 3 * j + 2 + r, 3 * j + 4 + r, 3 * j + 5 + r };
    return inSetU32(&p, winner);
}

fn inSetU32(set: []const u32, n: u32) bool {
    for (set) |v| {
        if (v == n) return true;
    }
    return false;
}

pub fn packBet(typ: u32, modifier: u32) u32 {
    return typ + modifier * 16;
}

pub fn evaluateBet(typ: u32, modifier: u32, winner: u32, deck_size: u32) u32 {
    const is_zero = winner == 0;
    const is_double_zero = deck_size == 38 and winner == 37;
    return switch (typ) {
        0 => if (winner == modifier) 35 else 0,
        1 => if (deck_size != 38) 0 else if (is_zero or is_double_zero) 17 else 0,
        2 => if (winner == splitLow(modifier) or winner == splitHigh(modifier)) 17 else 0,
        3 => blk: {
            const base = 3 * modifier + 1;
            break :blk if (winner >= base and winner <= base + 2) 11 else 0;
        },
        4 => if (cornerHas(modifier, winner)) 8 else 0,
        5 => if (deck_size == 37)
            (if (winner <= 3) 8 else 0)
        else if (is_zero or is_double_zero or (winner >= 1 and winner <= 3)) 6 else 0,
        6 => blk: {
            const lo = 3 * modifier + 1;
            break :blk if (winner >= lo and winner <= lo + 5) 5 else 0;
        },
        7 => if (is_zero or is_double_zero) 0 else if ((winner - 1) % 3 == modifier) 2 else 0,
        8 => if (is_zero or is_double_zero) 0 else if ((winner - 1) / 12 == modifier) 2 else 0,
        9 => if (is_zero or is_double_zero) 0 else if ((if (winner % 2 == 0) @as(u32, 0) else 1) == modifier) 1 else 0,
        10 => if (is_zero or is_double_zero) 0 else if (modifier == 0)
            (if (inSet(&RED, winner)) 1 else 0)
        else
            (if (inSet(&BLACK, winner)) 1 else 0),
        11 => if (is_zero or is_double_zero) 0 else if (modifier == 0)
            (if (winner >= 1 and winner <= 18) 1 else 0)
        else
            (if (winner >= 19 and winner <= 36) 1 else 0),
        else => 0,
    };
}
