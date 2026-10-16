//! One real Groth16 run of a named circuit. `ZK_PROFILE=1` makes the engine
//! print witness and prove phase lines around the work.
const std = @import("std");
const zk = @import("crypto/zk_crypto.zig");
const hash = @import("crypto/hash.zig");
const showdown_seal = @import("crypto/seal.zig");
const baby = @import("crypto/babyjub.zig");
const prove = @import("prove.zig");
const table = @import("player/table_player.zig");
const poker = @import("player/poker_player.zig");
const war = @import("player/war_player.zig");
const baccarat = @import("player/baccarat_player.zig");
const keno = @import("player/keno_player.zig");
const roulette = @import("player/roulette_player.zig");
const craps = @import("player/craps_player.zig");
const bingo = @import("player/bingo_player.zig");
const bingo_eval = @import("player/bingo_eval.zig");
const slot = @import("player/slot_player.zig");
const blackjack = @import("player/blackjack_player.zig");

const Fr = @import("crypto/fr.zig").Fr;
const Crypto = zk.Crypto;
const Ciphertext = zk.Ciphertext;
const PublicKey = zk.PublicKey;
const PlayerKey = zk.PlayerKey;
const CircuitId = prove.CircuitId;
const Engine = prove.Engine;

const Partials = struct {
    rows: [][]Ciphertext,
    flat: []Ciphertext,
    alloc: std.mem.Allocator,

    fn deinit(self: *Partials) void {
        self.alloc.free(self.rows);
        self.alloc.free(self.flat);
    }
};

pub fn run(alloc: std.mem.Allocator, name: []const u8) !void {
    const id = try parseId(name);
    var engine = try Engine.init(alloc);
    defer engine.deinit();
    if (!engine.available(id)) return error.CircuitUnavailable;
    switch (id) {
        .register_main => try runRegister(alloc, &engine),
        .shuffle_1_deck_52_main => try runStandardShuffle(alloc, &engine, 52, id),
        .shuffle_6_deck_52_main => try runStandardShuffle(alloc, &engine, 312, id),
        .shuffle_8_deck_52_main => try runStandardShuffle(alloc, &engine, 416, id),
        .shuffle_1_deck_37_main => try runStandardShuffle(alloc, &engine, 37, id),
        .shuffle_1_deck_38_main => try runStandardShuffle(alloc, &engine, 38, id),
        .shuffle_1_deck_75_main => try runStandardShuffle(alloc, &engine, 75, id),
        .shuffle_1_deck_80_main => try runStandardShuffle(alloc, &engine, 80, id),
        .shuffle_1_deck_90_main => try runStandardShuffle(alloc, &engine, 90, id),
        .shuffle_2_dice_6_main => try runCrapsShuffle(alloc, &engine),
        .shuffle_3_reel_22_main => try runSlotShuffle(alloc, &engine, 3),
        .shuffle_5_reel_22_main => try runSlotShuffle(alloc, &engine, 5),
        .poker_share_hashout_main => try runPokerShare(alloc, &engine),
        .poker_showdown_hashout_main => try runPokerShowdown(alloc, &engine),
        .baccarat_share_hashout_main => try runLinearShare(alloc, &engine, .baccarat, 52, 6, 11),
        .baccarat_showdown_hashout_main => try runBaccaratShowdown(alloc, &engine),
        .war_share_hashout_main => try runLinearShare(alloc, &engine, .war, 52, 4, 11),
        .war_showdown_hashout_main => try runWarShowdown(alloc, &engine),
        .blackjack_share_hashout_main => try runBlackjackShare(alloc, &engine),
        .blackjack_action_hashout_main => try runBlackjackAction(alloc, &engine),
        .blackjack_showdown_hashout_main => try runBlackjackShowdown(alloc, &engine),
        .roulette_share_hashout_main => try runLinearShare(alloc, &engine, .roulette, 37, 1, 11),
        .roulette_bet_37_main => try runRouletteBet(alloc, &engine, true),
        .roulette_bet_38_main => try runRouletteBet(alloc, &engine, false),
        .roulette_showdown_37_hashout_main => try runRouletteShowdown(alloc, &engine, true),
        .roulette_showdown_38_hashout_main => try runRouletteShowdown(alloc, &engine, false),
        .craps_share_hashout_main => try runLinearShare(alloc, &engine, .craps, 12, 2, 11),
        .craps_bet_main => try runCrapsBet(alloc, &engine),
        .craps_showdown_hashout_main => try runCrapsShowdown(alloc, &engine),
        .keno_share_hashout_main => try runLinearShare(alloc, &engine, .keno, 80, 20, 11),
        .keno_bet_main => try runKenoBet(alloc, &engine),
        .keno_showdown_hashout_main => try runKenoShowdown(alloc, &engine),
        .slot_share_3_reel_hashout_main => try runSlotShare(alloc, &engine, 3),
        .slot_share_5_reel_hashout_main => try runSlotShare(alloc, &engine, 5),
        .slot_showdown_3_reel_hashout_main => try runSlotShowdown(alloc, &engine, 3),
        .slot_showdown_5_reel_hashout_main => try runSlotShowdown(alloc, &engine, 5),
        .bingo_share_hashout_main => try runLinearShare(alloc, &engine, .bingo, 75, 5, 11),
        .bingo_card_75_main => try runBingoCard(alloc, &engine, 75),
        .bingo_card_90_main => try runBingoCard(alloc, &engine, 90),
        .bingo_showdown_75_hashout_main => try runBingoShowdown(alloc, &engine, 75),
        .bingo_showdown_90_hashout_main => try runBingoShowdown(alloc, &engine, 90),
    }
}

const GameTag = enum { war, baccarat, roulette, craps, keno, bingo };

fn parseId(name: []const u8) !CircuitId {
    inline for (@typeInfo(CircuitId).@"enum".fields) |field| {
        if (std.mem.eql(u8, name, field.name)) return @enumFromInt(field.value);
    }
    return error.UnknownCircuit;
}

/// Live slots get a distinct low limb. Later slots stay at bit 127 only and
/// are not part of the seal commitment.
fn sealShowdown(player: *table.TablePlayer, buf: *[showdown_seal.SLOTS]Fr, n_live: usize) void {
    for (buf, 0..) |*c, i| {
        const low: u64 = if (i < n_live) @intCast(i + 1) else 0;
        c.* = Fr.fromNormal(.{ low, 1 << 63, 0, 0 });
    }
    player.setSealed(buf);
}

fn encryptUnder(crypto: *Crypto, pk: PublicKey, src: []const Ciphertext, dest: []Ciphertext) void {
    for (src, dest) |card, *out| {
        out.* = crypto.encrypt(card.c1(), pk, crypto.rng.scalar253());
    }
}

fn collectPartials(
    alloc: std.mem.Allocator,
    crypto: *Crypto,
    cards: []const Ciphertext,
    prover: PublicKey,
    others: []const PlayerKey,
    poker_mask: ?u64,
) !Partials {
    const grid = try table.allocGrid(alloc, others.len, cards.len);
    const rand = try alloc.alloc(Fr, cards.len);
    defer alloc.free(rand);
    const one = try alloc.alloc(Ciphertext, cards.len);
    defer alloc.free(one);
    const recipients = [_]PublicKey{prover};
    var rand_view = [_][]const Fr{rand};
    var row_view = [_][]Ciphertext{one};
    for (others, 0..) |other, i| {
        crypto.generateShuffleRandomness(cards.len, rand);
        if (poker_mask) |mask| {
            poker.share(crypto, cards, mask, &recipients, other.private_key, &rand_view, &row_view);
        } else {
            crypto.share(cards, &recipients, other.private_key, &rand_view, &row_view);
        }
        @memcpy(grid.rows[i], one);
    }
    return .{ .rows = grid.rows, .flat = grid.flat, .alloc = alloc };
}

fn deal(alloc: std.mem.Allocator, crypto: *Crypto, keys: []const PublicKey) ![]Ciphertext {
    const n = crypto.catalog.len;
    const matrix = try alloc.alloc(u8, n * n);
    defer alloc.free(matrix);
    @memset(matrix, 0);
    var i: usize = 0;
    while (i < n) : (i += 1) matrix[i * n + ((i + 1) % n)] = 1;
    const rand = try alloc.alloc(Fr, n);
    defer alloc.free(rand);
    crypto.generateShuffleRandomness(n, rand);
    const out = try alloc.alloc(Ciphertext, n);
    crypto.shuffle(crypto.catalog, keys, matrix, rand, out, n);
    return out;
}

fn otherKeys(crypto: *Crypto, buf: []PlayerKey) void {
    for (buf) |*k| k.* = crypto.generatePlayerKey();
}

fn pubsFrom(prover: PublicKey, others: []const PlayerKey, out: []PublicKey) void {
    out[0] = prover;
    for (others, 0..) |k, i| out[i + 1] = k.public_key;
}

fn runRegister(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 1);
    defer crypto.deinit(alloc);
    var player = table.TablePlayer.init(alloc, engine, &crypto);
    var out = try player.registerProve();
    defer out.deinit();
}

fn runStandardShuffle(alloc: std.mem.Allocator, engine: *Engine, n: usize, id: CircuitId) !void {
    var crypto = try Crypto.init(alloc, n, 2);
    defer crypto.deinit(alloc);
    var player = table.TablePlayer.init(alloc, engine, &crypto);
    player.generateKey();
    const other = crypto.generatePlayerKey();
    var keys_buf: [12]PublicKey = undefined;
    const two = [_]PublicKey{ player.publicKey(), other.public_key };
    const keys = hash.padShuffleKeys(&two, &keys_buf);
    const matrix = try alloc.alloc(u8, n * n);
    defer alloc.free(matrix);
    @memset(matrix, 0);
    var i: usize = 0;
    while (i < n) : (i += 1) matrix[i * n + ((i + 1) % n)] = 1;
    const rand = try alloc.alloc(Fr, n);
    defer alloc.free(rand);
    crypto.generateShuffleRandomness(n, rand);
    const h = crypto.shuffleHash(crypto.catalog, keys);
    const json = try prove.json.shuffleJson(alloc, h, crypto.catalog, keys, matrix, rand);
    defer alloc.free(json);
    var proof = try engine.proveJson(id, json);
    defer proof.deinit();
    if (!try engine.verify(id, proof)) return error.ProofRejected;
}

fn runCrapsShuffle(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 6, 3);
    defer crypto.deinit(alloc);
    var player = craps.Player.init(alloc, engine, &crypto);
    player.generateKey();
    const other = crypto.generatePlayerKey();
    var dice: [12]Ciphertext = undefined;
    @memcpy(dice[0..6], crypto.catalog);
    @memcpy(dice[6..12], crypto.catalog);
    const keys = [_]PublicKey{ player.table.publicKey(), other.public_key };
    var out = try player.shuffleProve(&dice, &keys);
    defer out.deinit();
    if (!try engine.verify(.shuffle_2_dice_6_main, out.proof)) return error.ProofRejected;
}

fn runSlotShuffle(alloc: std.mem.Allocator, engine: *Engine, n_reels: u32) !void {
    var crypto = try Crypto.init(alloc, 22, 4);
    defer crypto.deinit(alloc);
    var player = slot.Player.init(alloc, engine, &crypto, n_reels);
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const reel: []const Ciphertext = crypto.catalog;
    var reels_buf: [5][]const Ciphertext = undefined;
    var r: usize = 0;
    while (r < n_reels) : (r += 1) reels_buf[r] = reel;
    const keys = [_]PublicKey{ player.table.publicKey(), house.public_key };
    var out = try player.shuffleProve(reels_buf[0..n_reels], &keys);
    defer out.deinit();
    const id: CircuitId = if (n_reels == 3) .shuffle_3_reel_22_main else .shuffle_5_reel_22_main;
    if (!try engine.verify(id, out.proof)) return error.ProofRejected;
}

fn runLinearShare(
    alloc: std.mem.Allocator,
    engine: *Engine,
    game: GameTag,
    shoe: usize,
    n_cards: usize,
    n_others: usize,
) !void {
    var crypto = try Crypto.init(alloc, shoe, 5);
    defer crypto.deinit(alloc);
    var others_buf: [11]PublicKey = undefined;
    const others = blk: {
        var i: usize = 0;
        while (i < n_others) : (i += 1) others_buf[i] = crypto.generatePlayerKey().public_key;
        break :blk others_buf[0..n_others];
    };
    var cards_buf: [20]Ciphertext = undefined;
    switch (game) {
        .war => {
            var player = war.Player.init(alloc, engine, &crypto);
            player.generateKey();
            encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_cards], cards_buf[0..n_cards]);
            var out = try player.shareProve(cards_buf[0..n_cards], others, 2);
            defer out.deinit();
        },
        .baccarat => {
            var player = baccarat.Player.init(alloc, engine, &crypto);
            player.generateKey();
            encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_cards], cards_buf[0..n_cards]);
            var out = try player.shareProve(cards_buf[0..n_cards], others, 2);
            defer out.deinit();
        },
        .roulette => {
            var player = roulette.Player.init(alloc, engine, &crypto, true);
            player.generateKey();
            encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_cards], cards_buf[0..n_cards]);
            var out = try player.shareProve(cards_buf[0..n_cards], others, 2);
            defer out.deinit();
        },
        .craps => {
            var player = craps.Player.init(alloc, engine, &crypto);
            player.generateKey();
            encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_cards], cards_buf[0..n_cards]);
            var out = try player.shareProve(cards_buf[0..n_cards], others, 2);
            defer out.deinit();
        },
        .keno => {
            var player = keno.Player.init(alloc, engine, &crypto);
            player.generateKey();
            encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_cards], cards_buf[0..n_cards]);
            var out = try player.shareProve(cards_buf[0..n_cards], others, 2);
            defer out.deinit();
        },
        .bingo => {
            var player = bingo.Player.init(alloc, engine, &crypto, 75);
            player.generateKey();
            encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_cards], cards_buf[0..n_cards]);
            var out = try player.shareProve(cards_buf[0..n_cards], others, 2);
            defer out.deinit();
        },
    }
}

fn runPokerShare(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 6);
    defer crypto.deinit(alloc);
    var player = poker.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var others: [9]PublicKey = undefined;
    for (&others) |*k| k.* = crypto.generatePlayerKey().public_key;
    var cards: [25]Ciphertext = undefined;
    encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..25], &cards);
    var out = try player.shareProve(&cards, &others, 2);
    defer out.deinit();
}

fn runPokerShowdown(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 7);
    defer crypto.deinit(alloc);
    var player = poker.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [9]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [10]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    const cards = deck[0..25];
    const mask = poker.shareCardMask(2);
    var partials = try collectPartials(alloc, &crypto, cards, pubs[0], &others, mask);
    defer partials.deinit();
    var pot: [9]Fr = undefined;
    // Pot bits select players, not cards. Two players in the main pot; side pots empty.
    pot[0] = Fr.fromU64(3);
    for (pot[1..]) |*p| p.* = Fr.zero();
    var shown = try player.showdownProve(0, &pubs, &pot, cards, partials.rows);
    defer shown.proof.deinit();
}

fn runWarShowdown(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 8);
    defer crypto.deinit(alloc);
    var player = war.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [11]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [12]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    var partials = try collectPartials(alloc, &crypto, deck[0..4], pubs[0], &others, null);
    defer partials.deinit();
    var shown = try player.showdownProve(&pubs, deck[0..4], partials.rows);
    defer shown.proof.deinit();
}

fn runBaccaratShowdown(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 9);
    defer crypto.deinit(alloc);
    var player = baccarat.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [11]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [12]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    var partials = try collectPartials(alloc, &crypto, deck[0..6], pubs[0], &others, null);
    defer partials.deinit();
    var shown = try player.showdownProve(&pubs, deck[0..6], partials.rows);
    defer shown.proof.deinit();
}

fn runBlackjackShare(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 10);
    defer crypto.deinit(alloc);
    var player = blackjack.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var others: [7]PublicKey = undefined;
    for (&others) |*k| k.* = crypto.generatePlayerKey().public_key;
    var cards: [16]Ciphertext = undefined;
    encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..16], &cards);
    var out = try player.shareProveChunk(&cards, &others, 2);
    defer out.deinit();
}

fn runBlackjackAction(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 11);
    defer crypto.deinit(alloc);
    var player = blackjack.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [7]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [8]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    const cards = deck[0..13];
    var partials = try collectPartials(alloc, &crypto, cards, pubs[0], &others, null);
    defer partials.deinit();
    var plain: [13]u64 = undefined;
    try crypto.decryptCards(player.table.privateKey(), cards, partials.rows, &plain);
    const pair = (plain[0] % 13) == (plain[1] % 13);
    var up_partials: [7]Ciphertext = undefined;
    for (partials.rows, 0..) |row, r| up_partials[r] = row[0];
    const insurance_eligible = @as(u32, @intCast(plain[0])) % 13 == 12;
    var proof = try player.actionProve(&pubs, cards, partials.rows, &plain, 2, pair, false, false, cards[0], up_partials[0..partials.rows.len], plain[0], insurance_eligible);
    defer proof.deinit();
}

fn runBlackjackShowdown(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 52, 12);
    defer crypto.deinit(alloc);
    var player = blackjack.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [7]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [8]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    const cards = deck[0..24];
    var partials = try collectPartials(alloc, &crypto, cards, pubs[0], &others, null);
    defer partials.deinit();
    var plain: [24]u64 = undefined;
    try crypto.decryptCards(player.table.privateKey(), cards, partials.rows, &plain);
    var proof = try player.showdownProve(&pubs, cards, partials.rows, &plain, 2, 2);
    defer proof.deinit();
}

fn runRouletteBet(alloc: std.mem.Allocator, engine: *Engine, eu: bool) !void {
    var crypto = try Crypto.init(alloc, if (eu) 37 else 38, 13);
    defer crypto.deinit(alloc);
    var player = roulette.Player.init(alloc, engine, &crypto, eu);
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const bets = [_][2]u32{ .{ 0, 17 }, .{ 10, 0 } };
    var proof = try player.betProve(house.public_key, &bets);
    defer proof.deinit();
}

fn runRouletteShowdown(alloc: std.mem.Allocator, engine: *Engine, eu: bool) !void {
    const shoe: usize = if (eu) 37 else 38;
    var crypto = try Crypto.init(alloc, shoe, 14);
    defer crypto.deinit(alloc);
    var player = roulette.Player.init(alloc, engine, &crypto, eu);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [11]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [12]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    var partials = try collectPartials(alloc, &crypto, deck[0..1], pubs[0], &others, null);
    defer partials.deinit();
    const bets = [_][2]u32{ .{ 0, 17 }, .{ 10, 0 } };
    var enc: [12]Ciphertext = undefined;
    var i: usize = 0;
    while (i < 12) : (i += 1) {
        const b = if (i < bets.len) bets[i] else [2]u32{ 0, 0 };
        enc[i] = roulette.encryptBet(&crypto, b[0], b[1], player.table.publicKey(), crypto.rng.scalar253());
    }
    var proof = try player.showdownProve(&pubs, deck[0..1], partials.rows, &enc, &bets, 2);
    defer proof.deinit();
}

fn runCrapsBet(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 12, 15);
    defer crypto.deinit(alloc);
    var player = craps.Player.init(alloc, engine, &crypto);
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const bets = [_][2]u32{ .{ 0, 0 }, .{ 8, 0 } };
    var proof = try player.betProve(house.public_key, &bets);
    defer proof.deinit();
}

fn encryptCraps(crypto: *Crypto, typ: u32, modifier: u32, pk: PublicKey) Ciphertext {
    const packed_bet: u64 = typ + modifier * 16;
    const pt = baby.mulBase8Limbs(.{ packed_bet + 1, 0, 0, 0 });
    return crypto.encrypt(pt, pk, crypto.rng.scalar253());
}

fn runCrapsShowdown(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 6, 16);
    defer crypto.deinit(alloc);
    var player = craps.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [11]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [12]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    var two_src: [2]Ciphertext = undefined;
    @memcpy(&two_src, crypto.catalog[0..2]);
    var crypto2 = try Crypto.init(alloc, 2, 16);
    defer crypto2.deinit(alloc);
    @memcpy(crypto2.catalog, &two_src);
    const dealt = try deal(alloc, &crypto2, &pubs);
    defer alloc.free(dealt);
    var partials = try collectPartials(alloc, &crypto2, dealt, pubs[0], &others, null);
    defer partials.deinit();
    const bets = [_][2]u32{ .{ 0, 0 }, .{ 8, 0 } };
    var enc: [12]Ciphertext = undefined;
    var i: usize = 0;
    while (i < 12) : (i += 1) {
        const b = if (i < bets.len) bets[i] else [2]u32{ 0, 0 };
        enc[i] = encryptCraps(&crypto2, b[0], b[1], player.table.publicKey());
    }
    var proof = try player.showdownProve(&pubs, dealt, partials.rows, &enc, &bets, 2, 0, 0);
    defer proof.deinit();
}

fn runKenoBet(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 80, 17);
    defer crypto.deinit(alloc);
    var player = keno.Player.init(alloc, engine, &crypto);
    player.generateKey();
    const house = crypto.generatePlayerKey();
    const spots = [_]u8{ 3, 11 };
    var out = try player.betProve(house.public_key, &spots);
    defer out.proof.deinit();
}

fn runKenoShowdown(alloc: std.mem.Allocator, engine: *Engine) !void {
    var crypto = try Crypto.init(alloc, 80, 18);
    defer crypto.deinit(alloc);
    var player = keno.Player.init(alloc, engine, &crypto);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [11]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [12]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    var partials = try collectPartials(alloc, &crypto, deck[0..20], pubs[0], &others, null);
    defer partials.deinit();
    const spots = [_]u8{ 3, 11 };
    var padded: [20]u8 = undefined;
    const all = keno.padSpots(&spots, &padded);
    var enc: [20]Ciphertext = undefined;
    for (all, 0..) |spot, i| {
        enc[i] = crypto.encryptScalar(spot, player.table.publicKey(), crypto.rng.scalar253());
    }
    var shown = try player.showdownProve(&pubs, deck[0..20], partials.rows, &enc, &spots, 2);
    defer shown.proof.deinit();
}

fn runSlotShare(alloc: std.mem.Allocator, engine: *Engine, n_reels: u32) !void {
    var crypto = try Crypto.init(alloc, 22, 19);
    defer crypto.deinit(alloc);
    var player = slot.Player.init(alloc, engine, &crypto, n_reels);
    player.generateKey();
    const house = crypto.generatePlayerKey();
    var centers_buf: [5]Ciphertext = undefined;
    encryptUnder(&crypto, player.table.publicKey(), crypto.catalog[0..n_reels], centers_buf[0..n_reels]);
    const keys = [_]PublicKey{house.public_key};
    var out = try player.shareProve(centers_buf[0..n_reels], &keys, 1);
    defer out.deinit();
}

fn runSlotShowdown(alloc: std.mem.Allocator, engine: *Engine, n_reels: u32) !void {
    var crypto = try Crypto.init(alloc, n_reels, 20);
    defer crypto.deinit(alloc);
    var player = slot.Player.init(alloc, engine, &crypto, n_reels);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    const house = crypto.generatePlayerKey();
    const pubs = [_]PublicKey{ player.table.publicKey(), house.public_key };
    const dealt = try deal(alloc, &crypto, &pubs);
    defer alloc.free(dealt);
    const others = [_]PlayerKey{house};
    var partials = try collectPartials(alloc, &crypto, dealt, pubs[0], &others, null);
    defer partials.deinit();
    const enc = slot.encryptCoinBet(&crypto, 1, player.table.publicKey(), crypto.rng.scalar253());
    var proof = try player.showdownProve(&pubs, dealt, partials.rows, enc, 1);
    defer proof.deinit();
}

fn fillBingo90(out: *[27]u8) void {
    @memset(out, 0);
    const lo = [_]u8{ 1, 10, 20, 30, 40, 50, 60, 70, 80 };
    var row: usize = 0;
    while (row < 3) : (row += 1) {
        var col: usize = 0;
        while (col < 5) : (col += 1) out[row * 9 + col] = lo[col] + @as(u8, @intCast(row));
    }
}

fn runBingoCard(alloc: std.mem.Allocator, engine: *Engine, variant: u32) !void {
    var crypto = try Crypto.init(alloc, variant, 21);
    defer crypto.deinit(alloc);
    var player = bingo.Player.init(alloc, engine, &crypto, variant);
    player.generateKey();
    if (variant == 75) {
        var cells: [25]u8 = undefined;
        bingo_eval.sample75(1, &cells);
        var proof = try player.cardProve(&cells);
        defer proof.deinit();
    } else {
        var cells: [27]u8 = undefined;
        fillBingo90(&cells);
        var proof = try player.cardProve(&cells);
        defer proof.deinit();
    }
}

fn runBingoShowdown(alloc: std.mem.Allocator, engine: *Engine, variant: u32) !void {
    var crypto = try Crypto.init(alloc, variant, 22);
    defer crypto.deinit(alloc);
    var player = bingo.Player.init(alloc, engine, &crypto, variant);
    player.generateKey();
    var sealed: [showdown_seal.SLOTS]Fr = undefined;
    sealShowdown(&player.table, &sealed, 2);
    var others: [11]PlayerKey = undefined;
    otherKeys(&crypto, &others);
    var pubs: [12]PublicKey = undefined;
    pubsFrom(player.table.publicKey(), &others, &pubs);
    const deck = try deal(alloc, &crypto, &pubs);
    defer alloc.free(deck);
    var partials = try collectPartials(alloc, &crypto, deck, pubs[0], &others, null);
    defer partials.deinit();
    var cells75: [25]u8 = undefined;
    var cells90: [27]u8 = undefined;
    const cells: []const u8 = if (variant == 75) blk: {
        bingo_eval.sample75(1, &cells75);
        break :blk &cells75;
    } else blk: {
        fillBingo90(&cells90);
        break :blk &cells90;
    };
    const rand = try alloc.alloc(Fr, cells.len);
    defer alloc.free(rand);
    crypto.generateShuffleRandomness(cells.len, rand);
    const card = try alloc.alloc(Ciphertext, cells.len);
    defer alloc.free(card);
    bingo.commitCard(&crypto, cells, player.table.publicKey(), rand, card);
    var proof = try player.showdownProve(&pubs, deck, partials.rows, card, cells, variant, 1);
    defer proof.deinit();
}
