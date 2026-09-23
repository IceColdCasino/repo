const THREE_PAY = [_][3]u32{
    .{ 500, 1000, 6000 },
    .{ 200, 400, 600 },
    .{ 75, 150, 225 },
    .{ 40, 80, 120 },
    .{ 20, 40, 60 },
    .{ 10, 20, 30 },
    .{ 5, 10, 15 },
};

const FIVE_PAY10 = [_][3]u32{
    .{ 5, 10, 25 },
    .{ 5, 10, 25 },
    .{ 7, 15, 40 },
    .{ 8, 20, 50 },
    .{ 10, 25, 60 },
    .{ 25, 60, 120 },
    .{ 50, 200, 250 },
};

pub const WILSON_STRIP_22 = [_]u8{ 3, 0, 5, 0, 3, 0, 6, 0, 4, 0, 5, 0, 2, 0, 5, 0, 2, 0, 6, 0, 4, 0 };

const STARBURST = [_][22]u8{
    .{ 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0 },
    .{ 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5 },
    .{ 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5 },
    .{ 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5, 6, 0, 1, 2, 7, 3, 4, 5 },
    .{ 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0 },
};

const PAYLINES = [_][5]u8{
    .{ 1, 1, 1, 1, 1 },
    .{ 0, 0, 0, 0, 0 },
    .{ 2, 2, 2, 2, 2 },
    .{ 0, 1, 2, 1, 0 },
    .{ 2, 1, 0, 1, 2 },
    .{ 0, 0, 1, 2, 2 },
    .{ 2, 2, 1, 0, 0 },
    .{ 1, 0, 0, 0, 1 },
    .{ 1, 2, 2, 2, 1 },
    .{ 0, 1, 1, 1, 0 },
};

fn isWild(s: u8) bool {
    return s == 7;
}

pub fn reelWindow(strip: []const u8, center: usize) struct { above: u8, center: u8, below: u8 } {
    const n = strip.len;
    const i = center % n;
    return .{
        .above = strip[(i + n - 1) % n],
        .center = strip[i],
        .below = strip[(i + 1) % n],
    };
}

fn allMatch(symbols: []const u8, comptime pred: fn (u8) bool) bool {
    for (symbols) |s| {
        if (!(isWild(s) or pred(s))) return false;
    }
    return true;
}

pub fn evaluateThreeReel(symbols: []const u8, coin_bet: u32) u32 {
    const d7 = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 6;
        }
    }.p);
    const s7 = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 5;
        }
    }.p);
    const any7 = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 5 or s == 6;
        }
    }.p);
    const tbar = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 4;
        }
    }.p);
    const dbar = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 3;
        }
    }.p);
    const sbar = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 2;
        }
    }.p);
    const anybar = allMatch(symbols, struct {
        fn p(s: u8) bool {
            return s == 2 or s == 3 or s == 4;
        }
    }.p);
    const wins = [_]bool{ d7, s7, any7, tbar, dbar, sbar, anybar };
    for (wins, 0..) |w, i| {
        if (w) return THREE_PAY[i][coin_bet - 1];
    }
    return 0;
}

pub fn evaluateThreeReelStops(centers: []const u32, coin_bet: u32) u32 {
    var symbols: [3]u8 = undefined;
    for (centers, 0..) |c, i| symbols[i] = reelWindow(&WILSON_STRIP_22, c).center;
    return evaluateThreeReel(&symbols, coin_bet);
}

fn countMatchFromLeft(symbols: []const u8) struct { count: u32, symbol: u8 } {
    var wild_sub: [5]bool = undefined;
    var i: usize = 0;
    while (i < 5) : (i += 1) {
        wild_sub[i] = i >= 1 and i <= 3 and isWild(symbols[i]);
    }
    var target: u8 = 0;
    var seen = false;
    i = 0;
    while (i < 5) : (i += 1) {
        if (!seen and !wild_sub[i]) {
            target = symbols[i];
            seen = true;
        }
    }
    const symbol: u8 = if (!seen or target == 7) 6 else target;
    var count: u32 = 0;
    i = 0;
    while (i < 5) : (i += 1) {
        if (wild_sub[i] or symbols[i] == symbol) {
            count += 1;
        } else break;
    }
    return .{ .count = count, .symbol = symbol };
}

fn payMult10(symbol: u8, count: u32) u32 {
    if (count < 3 or count > 5 or symbol > 6) return 0;
    return FIVE_PAY10[symbol][count - 3];
}

fn evaluatePayline(symbols: []const u8) u32 {
    const ltr = countMatchFromLeft(symbols);
    var rev: [5]u8 = undefined;
    var i: usize = 0;
    while (i < 5) : (i += 1) rev[i] = symbols[4 - i];
    const rtl = countMatchFromLeft(&rev);
    const a = payMult10(ltr.symbol, ltr.count);
    const b = payMult10(rtl.symbol, rtl.count);
    return if (a > b) a else b;
}

pub fn evaluateFiveReelStops(centers: []const u32, coin_bet: u32) u32 {
    var grid: [5][3]u8 = undefined;
    var reel: usize = 0;
    while (reel < 5) : (reel += 1) {
        const w = reelWindow(&STARBURST[reel], centers[reel]);
        grid[reel] = .{ w.above, w.center, w.below };
        if (reel >= 1 and reel <= 3) {
            if (w.above == 7 or w.center == 7 or w.below == 7) {
                grid[reel] = .{ 7, 7, 7 };
            }
        }
    }
    var mult10: u32 = 0;
    for (PAYLINES) |line| {
        var symbols: [5]u8 = undefined;
        reel = 0;
        while (reel < 5) : (reel += 1) symbols[reel] = grid[reel][line[reel]];
        mult10 += evaluatePayline(&symbols);
    }
    return mult10 * coin_bet;
}
