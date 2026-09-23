const std = @import("std");
const Fr = @import("crypto/fr.zig").Fr;
const simd = @import("crypto/fr_simd.zig");
const poseidon = @import("crypto/poseidon.zig");
const baby = @import("crypto/babyjub.zig");
const elg = @import("crypto/elgamal.zig");
const hash = @import("crypto/hash.zig");
const poly = @import("crypto/poly_hash.zig");
const zk = @import("crypto/zk_crypto.zig");
const poker = @import("player/poker_player.zig");
const keno = @import("player/keno_player.zig");
const bingo = @import("player/bingo_player.zig");
const bj = @import("player/blackjack_player.zig");
const baccarat = @import("player/baccarat_player.zig");
const war = @import("player/war_player.zig");
const roulette = @import("player/roulette_player.zig");
const craps = @import("player/craps_player.zig");
const slot = @import("player/slot_player.zig");

const vectors_json = @embedFile("player_vectors/crypto.json");

fn expectDec(actual: Fr, expected: []const u8) !void {
    var buf: [80]u8 = undefined;
    const got = actual.toDec(&buf);
    try std.testing.expectEqualStrings(expected, got);
}

fn parseRoot(allocator: std.mem.Allocator) !std.json.Parsed(std.json.Value) {
    return std.json.parseFromSlice(std.json.Value, allocator, vectors_json, .{});
}

test "libfr add/mul/pow5 and SIMD lanes" {
    const seven = Fr.fromU64(7);
    const eleven = Fr.fromU64(11);
    try expectDec(seven.add(eleven), "18");
    try expectDec(seven.mul(eleven), "77");
    try expectDec(seven.pow5(), "16807");

    const a = simd.splat(seven);
    const b = simd.splat(eleven);
    const sum = simd.add4(a, b);
    const prod = simd.mul4(a, b);
    inline for (0..4) |i| {
        try expectDec(sum[i], "18");
        try expectDec(prod[i], "77");
    }
    try std.testing.expect(seven.inv().mul(seven).eql(Fr.one()));
}

test "poseidon matches circomlibjs" {
    var parsed = try parseRoot(std.testing.allocator);
    defer parsed.deinit();
    const cases = parsed.value.object.get("poseidon").?.array.items;
    for (cases) |case| {
        const inputs_json = case.object.get("inputs").?.array.items;
        var buf: [16]Fr = undefined;
        for (inputs_json, 0..) |item, i| buf[i] = Fr.fromDec(item.string);
        try expectDec(poseidon.hash(buf[0..inputs_json.len]), case.object.get("out").?.string);
    }
}

test "babyjub Base8 scalar mul matches circomlibjs" {
    var parsed = try parseRoot(std.testing.allocator);
    defer parsed.deinit();
    for (parsed.value.object.get("babyjub").?.array.items) |case| {
        const k = Fr.fromDec(case.object.get("k").?.string);
        const p = baby.mulBase8(k);
        try std.testing.expect(baby.inCurve(p));
        try expectDec(p.x, case.object.get("x").?.string);
        try expectDec(p.y, case.object.get("y").?.string);
    }
}

test "elgamal encrypt identity" {
    var parsed = try parseRoot(std.testing.allocator);
    defer parsed.deinit();
    const eg = parsed.value.object.get("elgamal").?;
    const sk = Fr.fromDec(eg.object.get("sk").?.string);
    const r = Fr.fromDec(eg.object.get("r").?.string);
    const pk = baby.mulBase8(sk);
    const ct = elg.encrypt(baby.Point.identity(), pk, r);
    const exp = eg.object.get("ciphertext").?.array.items;
    try expectDec(ct.c0x, exp[0].string);
    try expectDec(ct.c0y, exp[1].string);
    try expectDec(ct.c1x, exp[2].string);
    try expectDec(ct.c1y, exp[3].string);
}

test "hash helpers and shuffle" {
    var parsed = try parseRoot(std.testing.allocator);
    defer parsed.deinit();
    const hashes = parsed.value.object.get("hashes").?;

    var crypto = try zk.Crypto.init(std.testing.allocator, 4, 1);
    defer crypto.deinit(std.testing.allocator);

    const sk = Fr.fromDec("123456789");
    const pk = baby.mulBase8(sk);
    const id = baby.Point.identity();

    try expectDec(hash.hashPublicKeys2(&.{ pk, id }), hashes.object.get("publicKeys2").?.string);

    var keys10: [10]baby.Point = undefined;
    keys10[0] = pk;
    for (keys10[1..]) |*k| k.* = id;
    try expectDec(hash.hashPublicKeys10(&keys10), hashes.object.get("publicKeys10").?.string);

    var keys12: [12]baby.Point = undefined;
    keys12[0] = pk;
    for (keys12[1..]) |*k| k.* = id;
    try expectDec(hash.hashPublicKeys12(&keys12), hashes.object.get("publicKeys12").?.string);

    try expectDec(crypto.hashCiphertexts(crypto.catalog), hashes.object.get("ciphertexts4").?.string);

    const perm = [_]u8{
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
        1, 0, 0, 0,
    };
    const randomness = [_]Fr{ Fr.fromU64(2), Fr.fromU64(3), Fr.fromU64(4), Fr.fromU64(5) };
    var out: [4]zk.Ciphertext = undefined;
    const ph = crypto.shuffle(crypto.catalog, &.{pk}, &perm, &randomness, &out, 4);
    const sh = parsed.value.object.get("shuffle").?;
    try expectDec(ph, sh.object.get("permutationHash").?.string);
    const exp_out = sh.object.get("out").?.array.items;
    for (out, 0..) |ct, i| {
        const row = exp_out[i].array.items;
        try expectDec(ct.c0x, row[0].string);
        try expectDec(ct.c0y, row[1].string);
        try expectDec(ct.c1x, row[2].string);
        try expectDec(ct.c1y, row[3].string);
    }
}

test "poker share/showdown/eval" {
    var parsed = try parseRoot(std.testing.allocator);
    defer parsed.deinit();
    const pvec = parsed.value.object.get("poker").?;

    var crypto = try zk.Crypto.init(std.testing.allocator, 52, 1);
    defer crypto.deinit(std.testing.allocator);
    const sk = Fr.fromDec("123456789");
    const pk = baby.mulBase8(sk);
    const id = baby.Point.identity();
    var others: [9]baby.Point = undefined;
    for (&others) |*k| k.* = id;

    try expectDec(poker.shareHash(&crypto, crypto.catalog[0..4], 0b1111, pk, &others), pvec.object.get("shareHash").?.string);

    var keys10: [10]baby.Point = undefined;
    keys10[0] = pk;
    for (keys10[1..]) |*k| k.* = id;
    var pots: [9]Fr = undefined;
    for (&pots) |*m| m.* = Fr.one();
    var partial_rows: [9][]const zk.Ciphertext = undefined;
    var i: usize = 0;
    while (i < 9) : (i += 1) partial_rows[i] = crypto.catalog[0..25];
    try expectDec(
        poker.showdownHash(&crypto, &pots, &keys10, Fr.zero(), crypto.catalog[0..25], &partial_rows),
        pvec.object.get("showdownHash").?.string,
    );

    const plaintext = [_]u64{ 0, 12, 25, 38, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 14, 27, 40, 50 };
    var winners: [1]u64 = undefined;
    poker.compareHands(&.{0b11}, &plaintext, &winners);
    try std.testing.expectEqual(std.fmt.parseInt(u64, pvec.object.get("winnerMasks").?.array.items[0].string, 10) catch unreachable, winners[0]);

    var coeffs: [9]Fr = undefined;
    i = 0;
    while (i < 9) : (i += 1) coeffs[i] = Fr.fromU64(@intCast(i + 1));
    try expectDec(poker.computeCoefficientCommitment(&coeffs), pvec.object.get("coeffCommit").?.string);

    try expectDec(poly.extractAndCombine(Fr.fromHex("123456789abcdef0123456789abcdef")), pvec.object.get("extract").?.string);

    var vals: [900]Fr = undefined;
    i = 0;
    while (i < 900) : (i += 1) vals[i] = Fr.fromU64(@intCast(i + 1));
    try expectDec(poly.hash900(&vals, 2), pvec.object.get("hash900n2").?.string);
}

test "game evaluators" {
    var parsed = try parseRoot(std.testing.allocator);
    defer parsed.deinit();
    const g = parsed.value.object.get("games").?;

    const spots = [_]u8{ 1, 2, 3, 4, 5 };
    var padded: [20]u8 = undefined;
    const all = keno.padSpots(&spots, &padded);
    const draw = [_]u8{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 };
    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("kenoMatches").?.integer)), keno.evaluate(&draw, all, 5));

    const pk = baby.mulBase8(Fr.fromDec("123456789"));
    try expectDec(keno.betHash(pk, baby.Point.identity(), 5), g.object.get("kenoBetHash").?.string);

    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("baccarat").?.integer)), baccarat.evaluate(&.{ 0, 12, 1, 13, 2, 14 }));
    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("war").?.integer)), war.evaluate(&.{ 12, 0, 11, 1 }));

    const hv = bj.computeHandValue(&.{ 12, 0 }, 2);
    const bj_json = g.object.get("blackjack").?;
    try std.testing.expectEqual(@as(u32, @intCast(bj_json.object.get("bestValue").?.integer)), hv.best_value);
    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("blackjackVsDealer").?.integer)), bj.compareToDealer(hv, bj.computeHandValue(&.{ 1, 2 }, 2)));

    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("roulette").?.integer)), roulette.evaluateBet(0, 17, 17, 37));

    var cells: [25]u8 = undefined;
    bingo.sample75(0, &cells);
    var balls: [20]u8 = undefined;
    var i: u8 = 0;
    while (i < 20) : (i += 1) balls[i] = i;
    const b75 = bingo.evaluate75(&cells, &balls, 20, 0);
    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("bingo75").?.object.get("packed").?.integer)), b75.packed_term);

    const cr = craps.evaluateCraps(&.{ 5, 0 }, 0, 0);
    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("craps").?.object.get("action").?.integer)), cr.action);
    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("craps").?.object.get("pointOut").?.integer)), cr.point_out);

    try std.testing.expectEqual(@as(u32, @intCast(g.object.get("slot3").?.integer)), slot.evaluateThreeReelStops(&.{ 0, 1, 2 }, 1));
}

test "rng field is libfr mod q, not 253-bit" {
    var rng = zk.Rng.init(1);
    var saw_bit_253 = false;
    var i: usize = 0;
    while (i < 64) : (i += 1) {
        const n = rng.field().toNormal();
        try std.testing.expect(Fr.limbsLtQ(n));
        if (n[3] & (@as(u64, 1) << 61) != 0) saw_bit_253 = true;
    }
    try std.testing.expect(saw_bit_253);
    try std.testing.expect(Fr.limbsLtQ(Fr.fromNormalModQ(.{
        0xffff_ffff_ffff_ffff,
        0xffff_ffff_ffff_ffff,
        0xffff_ffff_ffff_ffff,
        0xffff_ffff_ffff_ffff,
    }).toNormal()));
}

test "derangement has no fixed points" {
    var crypto = try zk.Crypto.init(std.testing.allocator, 52, 7);
    defer crypto.deinit(std.testing.allocator);
    var perm: [52]u16 = undefined;
    crypto.derangement(&perm);
    var seen = [_]bool{false} ** 52;
    for (perm, 0..) |dst, src| {
        try std.testing.expect(dst != src);
        try std.testing.expect(dst < 52);
        try std.testing.expect(!seen[dst]);
        seen[dst] = true;
    }
}

test "decrypt with sk searches pre-generated catalog" {
    var crypto = try zk.Crypto.init(std.testing.allocator, 52, 1);
    defer crypto.deinit(std.testing.allocator);
    const key = crypto.generatePlayerKey();

    try std.testing.expectEqual(@as(isize, 5), crypto.decryptWithSk(key.private_key, crypto.catalog[5]));
    try std.testing.expectEqual(@as(isize, 51), poker.lookupCatalog(&crypto, crypto.catalog[51].c1()));

    const r = crypto.rng.scalar253();
    const ct = crypto.encryptScalar(17, key.public_key, r);
    try std.testing.expectEqual(@as(isize, 17), poker.decryptWithSk(&crypto, key.private_key, ct));
    try std.testing.expectEqual(@as(isize, 17), crypto.decryptCard(ct, elg.createPartial(key.private_key, ct)));
}

test "player modules compile" {
    _ = poker;
    _ = keno;
    _ = bingo;
    _ = bj;
    _ = baccarat;
    _ = war;
    _ = roulette;
    _ = craps;
    _ = slot;
}
