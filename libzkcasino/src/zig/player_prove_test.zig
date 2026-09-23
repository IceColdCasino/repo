const std = @import("std");
const zk = @import("crypto/zk_crypto.zig");
const prove = @import("prove.zig");
const poker = @import("player/poker_player.zig");
const war = @import("player/war_player.zig");
const baccarat = @import("player/baccarat_player.zig");
const keno = @import("player/keno_player.zig");
const roulette = @import("player/roulette_player.zig");
const craps = @import("player/craps_player.zig");
const bingo = @import("player/bingo_player.zig");
const slot = @import("player/slot_player.zig");
const blackjack = @import("player/blackjack_player.zig");

const PublicKey = zk.PublicKey;
const Engine = prove.Engine;

fn openEngine() !Engine {
    return Engine.init(std.testing.allocator) catch |err| switch (err) {
        error.RepoRootNotFound, error.RapidsnarkOpen, error.CwdUnavailable => return error.SkipZigTest,
        else => return err,
    };
}

fn encryptUnder(crypto: *zk.Crypto, pk: PublicKey, src: []const zk.Ciphertext, dest: []zk.Ciphertext) void {
    for (src, dest) |card, *out| {
        out.* = crypto.encrypt(card.c1(), pk, crypto.rng.scalar253());
    }
}

fn expectValid(engine: *Engine, id: prove.CircuitId, proof: prove.Proof) !void {
    try std.testing.expect(proof.proof_json.len > 8);
    try std.testing.expect(proof.public_json.len > 2);
    try std.testing.expect(try engine.verify(id, proof));
}

test "game players compile" {
    _ = poker.Player;
    _ = war.Player;
    _ = baccarat.Player;
    _ = keno.Player;
    _ = roulette.Player;
    _ = craps.Player;
    _ = bingo.Player;
    _ = slot.Player;
    _ = blackjack.Player;
}

test "every game player registerProve + verify" {
    std.debug.print("test: register all games\n", .{});
    const alloc = std.testing.allocator;
    var engine = try openEngine();
    defer engine.deinit();
    if (!engine.available(.register_main)) return error.SkipZigTest;

    var crypto = try zk.Crypto.init(alloc, 1, 7);
    defer crypto.deinit(alloc);

    {
        var p = poker.Player.init(alloc, &engine, &crypto);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = war.Player.init(alloc, &engine, &crypto);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = baccarat.Player.init(alloc, &engine, &crypto);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = keno.Player.init(alloc, &engine, &crypto);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = roulette.Player.init(alloc, &engine, &crypto, true);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = craps.Player.init(alloc, &engine, &crypto);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = bingo.Player.init(alloc, &engine, &crypto, 75);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = slot.Player.init(alloc, &engine, &crypto, 3);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
    {
        var p = blackjack.Player.init(alloc, &engine, &crypto);
        defer p.deinit();
        p.generateKey();
        var out = try p.registerProve();
        defer out.deinit();
        try expectValid(&engine, .register_main, out.proof);
    }
}

test "poker shuffleProve + verify" {
    std.debug.print("test: poker shuffle\n", .{});
    const alloc = std.testing.allocator;
    var engine = try openEngine();
    defer engine.deinit();
    if (!engine.available(.shuffle_1_deck_52_main)) return error.SkipZigTest;

    var crypto = try zk.Crypto.init(alloc, 52, 11);
    defer crypto.deinit(alloc);

    var player = poker.Player.init(alloc, &engine, &crypto);
    defer player.deinit();
    player.generateKey();
    const other = crypto.generatePlayerKey();
    const keys = [_]PublicKey{ player.table.publicKey(), other.public_key };

    var out = try player.shuffleProve(crypto.catalog, &keys);
    defer out.deinit();
    try expectValid(&engine, .shuffle_1_deck_52_main, out.proof);
}

test "roulette shuffleProve + betProve + verify" {
    std.debug.print("test: roulette shuffle+bet\n", .{});
    const alloc = std.testing.allocator;
    var engine = try openEngine();
    defer engine.deinit();
    if (!engine.available(.shuffle_1_deck_37_main)) return error.SkipZigTest;

    var crypto = try zk.Crypto.init(alloc, 37, 13);
    defer crypto.deinit(alloc);

    var player = roulette.Player.init(alloc, &engine, &crypto, true);
    defer player.deinit();
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const keys = [_]PublicKey{ player.table.publicKey(), house.public_key };

    var shuffled = try player.shuffleProve(crypto.catalog, &keys);
    defer shuffled.deinit();
    try expectValid(&engine, .shuffle_1_deck_37_main, shuffled.proof);

    if (engine.available(.roulette_bet_37_main)) {
        const bets = [_][2]u32{ .{ 0, 17 }, .{ 10, 0 } };
        var bet = try player.betProve(house.public_key, &bets);
        defer bet.deinit();
        try expectValid(&engine, .roulette_bet_37_main, bet);
    }
}

test "craps betProve + verify" {
    std.debug.print("test: craps bet\n", .{});
    const alloc = std.testing.allocator;
    var engine = try openEngine();
    defer engine.deinit();
    if (!engine.available(.craps_bet_main)) return error.SkipZigTest;

    var crypto = try zk.Crypto.init(alloc, 12, 17);
    defer crypto.deinit(alloc);

    var player = craps.Player.init(alloc, &engine, &crypto);
    defer player.deinit();
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const bets = [_][2]u32{ .{ 0, 0 }, .{ 8, 0 } };
    var bet = try player.betProve(house.public_key, &bets);
    defer bet.deinit();
    try expectValid(&engine, .craps_bet_main, bet);
}

test "slot shareProve + verify" {
    std.debug.print("test: slot share\n", .{});
    const alloc = std.testing.allocator;
    var engine = try openEngine();
    defer engine.deinit();
    if (!engine.available(.slot_share_3_reel_hashout_main)) return error.SkipZigTest;

    var crypto = try zk.Crypto.init(alloc, 3, 19);
    defer crypto.deinit(alloc);

    var player = slot.Player.init(alloc, &engine, &crypto, 3);
    defer player.deinit();
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const keys = [_]PublicKey{house.public_key};
    var centers: [3]zk.Ciphertext = undefined;
    encryptUnder(&crypto, player.table.publicKey(), crypto.catalog, &centers);

    var out = try player.shareProve(&centers, &keys, 1);
    defer out.deinit();
    try expectValid(&engine, .slot_share_3_reel_hashout_main, out.proof);
}

test "roulette shareProve + verify" {
    std.debug.print("test: roulette share\n", .{});
    const alloc = std.testing.allocator;
    var engine = try openEngine();
    defer engine.deinit();
    if (!engine.available(.roulette_share_hashout_main)) return error.SkipZigTest;

    var crypto = try zk.Crypto.init(alloc, 1, 23);
    defer crypto.deinit(alloc);

    var player = roulette.Player.init(alloc, &engine, &crypto, true);
    defer player.deinit();
    player.generateKey();

    var others: [11]PublicKey = undefined;
    others[0] = crypto.generatePlayerKey().public_key;
    var i: usize = 1;
    while (i < 11) : (i += 1) others[i] = PublicKey.identity();
    var cards: [1]zk.Ciphertext = undefined;
    encryptUnder(&crypto, player.table.publicKey(), crypto.catalog, &cards);

    var out = try player.shareProve(&cards, &others, 2);
    defer out.deinit();
    try expectValid(&engine, .roulette_share_hashout_main, out.proof);
}
