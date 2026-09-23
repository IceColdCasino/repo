const std = @import("std");

pub const EvaluatedHand = [7]u64;

fn zeroFill(src: []const u64) EvaluatedHand {
    var out = [_]u64{0} ** 7;
    @memcpy(out[0..src.len], src);
    return out;
}

fn sortDesc(items: []u64) void {
    std.mem.sort(u64, items, {}, struct {
        fn lt(_: void, a: u64, b: u64) bool {
            return a > b;
        }
    }.lt);
}

const Freq = struct {
    ranks: [13]u8 = .{0} ** 13,
    suits: [4]u8 = .{0} ** 4,
};

fn frequencies(cards: []const u64) Freq {
    var f = Freq{};
    for (cards) |card| {
        f.ranks[card % 13] += 1;
        f.suits[card / 13] += 1;
    }
    return f;
}

fn straightCheck(ranks: [13]u8) ?EvaluatedHand {
    const seq = [_]u64{ 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 12 };
    var i: usize = 0;
    while (i + 4 < seq.len) : (i += 1) {
        var ok = true;
        var set: [5]u64 = undefined;
        var k: usize = 0;
        while (k < 5) : (k += 1) {
            set[k] = seq[i + k];
            if (ranks[set[k]] == 0) ok = false;
        }
        if (ok) {
            return zeroFill(&.{ 5, set[0], set[1], set[2], set[3], set[4] });
        }
    }
    return null;
}

fn flushCheck(cards: []const u64, f: Freq) ?EvaluatedHand {
    var flush_suit: i32 = -1;
    var s: usize = 0;
    while (s < 4) : (s += 1) {
        if (f.suits[s] >= 5) {
            flush_suit = @intCast(s);
            break;
        }
    }
    if (flush_suit < 0) return null;
    var ranks: [7]u64 = undefined;
    var n: usize = 0;
    for (cards) |card| {
        if (card / 13 == @as(u64, @intCast(flush_suit))) {
            ranks[n] = card % 13;
            n += 1;
        }
    }
    sortDesc(ranks[0..n]);
    return zeroFill(&.{ 6, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4], @intCast(flush_suit) });
}

fn straightFlushCheck(cards: []const u64, straight: ?EvaluatedHand, flush: ?EvaluatedHand) ?EvaluatedHand {
    if (straight == null or flush == null) return null;
    const flush_type = flush.?[6];
    var ranks = [_]u8{0} ** 13;
    for (cards) |card| {
        if (card / 13 == flush_type) ranks[card % 13] = 1;
    }
    const sf = straightCheck(ranks) orelse return null;
    return zeroFill(&.{ 9, sf[1], sf[2], sf[3], sf[4], sf[5], flush_type });
}

fn nOfAKind(n: u8, f: Freq) ?EvaluatedHand {
    var kinds: [13]u64 = undefined;
    var kickers: [13]u64 = undefined;
    var nk: usize = 0;
    var nkick: usize = 0;
    var r: usize = 0;
    while (r < 13) : (r += 1) {
        if (f.ranks[r] == 0) continue;
        if (f.ranks[r] == n) {
            kinds[nk] = r;
            nk += 1;
        } else {
            kickers[nkick] = r;
            nkick += 1;
        }
    }
    if (nk < 1) return null;
    sortDesc(kinds[0..nk]);
    const max_kinds: usize = if (n < 3) 2 else 1;
    const take = @min(nk, max_kinds);
    var i = take;
    while (i < nk) : (i += 1) {
        kickers[nkick] = kinds[i];
        nkick += 1;
    }
    sortDesc(kickers[0..nkick]);
    const hand_type: u64 = switch (n) {
        4 => 8,
        3 => 4,
        2 => take + 1,
        else => unreachable,
    };
    var out: [7]u64 = .{hand_type} ++ .{0} ** 6;
    var o: usize = 1;
    i = 0;
    while (i < take) : (i += 1) {
        out[o] = kinds[i];
        o += 1;
    }
    const kicker_need = 5 - take * n;
    i = 0;
    while (i < kicker_need and i < nkick) : (i += 1) {
        out[o] = kickers[i];
        o += 1;
    }
    return out;
}

fn fullHouse(f: Freq) ?EvaluatedHand {
    var sets: [13]u64 = undefined;
    var pairs: [13]u64 = undefined;
    var ns: usize = 0;
    var np: usize = 0;
    var r: usize = 0;
    while (r < 13) : (r += 1) {
        if (f.ranks[r] == 3) {
            sets[ns] = r;
            ns += 1;
        } else if (f.ranks[r] == 2) {
            pairs[np] = r;
            np += 1;
        }
    }
    if (ns < 1 or (ns < 2 and np < 1)) return null;
    sortDesc(sets[0..ns]);
    sortDesc(pairs[0..np]);
    const pair = if (ns > 1) sets[1] else pairs[0];
    return zeroFill(&.{ 7, sets[0], pair });
}

fn highCard(f: Freq) EvaluatedHand {
    var keys: [13]u64 = undefined;
    var n: usize = 0;
    var r: usize = 0;
    while (r < 13) : (r += 1) {
        if (f.ranks[r] > 0) {
            keys[n] = r;
            n += 1;
        }
    }
    sortDesc(keys[0..n]);
    return zeroFill(&.{ 1, keys[0], keys[1], keys[2], keys[3], keys[4] });
}

pub fn evaluateHand(cards: []const u64) EvaluatedHand {
    const f = frequencies(cards);
    const straight = straightCheck(f.ranks);
    const flush = flushCheck(cards, f);
    if (straightFlushCheck(cards, straight, flush)) |sf| return sf;
    if (nOfAKind(4, f)) |v| return v;
    const full = fullHouse(f);
    if (full) |v| return v;
    if (flush) |v| return v;
    if (straight) |v| return v;
    if (nOfAKind(3, f)) |v| return v;
    if (nOfAKind(2, f)) |v| return v;
    return highCard(f);
}

pub fn compareEvaluated(a: EvaluatedHand, b: EvaluatedHand) i32 {
    var i: usize = 0;
    while (i < 6) : (i += 1) {
        if (a[i] > b[i]) return -1;
        if (a[i] < b[i]) return 1;
    }
    return 0;
}

pub fn compareAllHands(hands: []const EvaluatedHand) u64 {
    var top = hands[0];
    for (hands[1..]) |h| {
        if (compareEvaluated(top, h) > 0) top = h;
    }
    var mask: u64 = 0;
    for (hands, 0..) |h, i| {
        if (compareEvaluated(top, h) == 0) mask |= @as(u64, 1) << @intCast(i);
    }
    return mask;
}

pub fn winnerMasks(pot_masks: []const u64, plaintext: []const u64, out: []u64) void {
    for (pot_masks, 0..) |pot_mask, pi| {
        if (pot_mask < 1) {
            out[pi] = 0;
            continue;
        }
        var hands: [10]EvaluatedHand = undefined;
        var p: usize = 0;
        while (p < 10) : (p += 1) {
            if ((pot_mask >> @intCast(p)) & 1 != 0) {
                var cards: [7]u64 = undefined;
                cards[0] = plaintext[p * 2];
                cards[1] = plaintext[p * 2 + 1];
                @memcpy(cards[2..], plaintext[20..25]);
                hands[p] = evaluateHand(&cards);
            } else {
                hands[p] = .{ 0, 0, 0, 0, 0, 0, 0 };
            }
        }
        out[pi] = compareAllHands(&hands);
    }
}
