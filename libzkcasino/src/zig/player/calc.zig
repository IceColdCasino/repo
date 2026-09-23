//! Hash and catalog calculations for the host. No Groth16.
const std = @import("std");
const ops = @import("bridge_ops.zig");
const zk = @import("../crypto/zk_crypto.zig");
const hash = @import("../crypto/hash.zig");
const poseidon = @import("../crypto/poseidon.zig");
const poly = @import("../crypto/poly_hash.zig");
const poker = @import("poker_math.zig");
const war = @import("war_player.zig");
const baccarat = @import("baccarat_player.zig");
const blackjack = @import("blackjack_player.zig");
const roulette = @import("roulette_player.zig");
const craps = @import("craps_player.zig");
const keno = @import("keno_player.zig");
const slot = @import("slot_player.zig");
const bingo = @import("bingo_player.zig");

const Fr = @import("../crypto/fr.zig").Fr;
const Crypto = zk.Crypto;
const Ciphertext = zk.Ciphertext;
const PublicKey = zk.PublicKey;
const Writer = ops.Writer;

pub const Kind = enum(u32) {
    poker = 0,
    baccarat = 1,
    blackjack = 2,
    war = 3,
    roulette = 4,
    craps = 5,
    keno = 6,
    slots = 7,
    bingo = 8,
};

const Grid = struct {
    flat: []Ciphertext,
    rows: [][]const Ciphertext,

    fn deinit(self: *Grid, alloc: std.mem.Allocator) void {
        alloc.free(self.rows);
        alloc.free(self.flat);
    }
};

fn kindFrom(kind_u: u32) !Kind {
    return switch (kind_u) {
        0 => .poker,
        1 => .baccarat,
        2 => .blackjack,
        3 => .war,
        4 => .roulette,
        5 => .craps,
        6 => .keno,
        7 => .slots,
        8 => .bingo,
        else => error.InvalidGameKind,
    };
}

pub fn run(alloc: std.mem.Allocator, crypto: *const Crypto, kind_u: u32, root: std.json.Value, w: *Writer) !void {
    const kind = try kindFrom(kind_u);
    const name = ops.asDec(root.object.get("fn") orelse return error.MissingCalcFn);
    if (std.mem.eql(u8, name, "initialDeck")) {
        try writeInitialDeck(alloc, root, w);
        return;
    }
    if (std.mem.eql(u8, name, "shuffleHash")) {
        try writeFr(w, try shuffleHash(alloc, crypto, kind, root));
        return;
    }
    if (std.mem.eql(u8, name, "shareHash")) {
        try writeFr(w, try shareHash(alloc, crypto, kind, root));
        return;
    }
    if (std.mem.eql(u8, name, "shareOutputHash")) {
        try writeFr(w, try shareOutputHash(alloc, kind, root));
        return;
    }
    if (std.mem.eql(u8, name, "showdownHash")) {
        try writeFr(w, try showdownHash(alloc, crypto, kind, root));
        return;
    }
    if (std.mem.eql(u8, name, "betHash")) {
        try writeFr(w, try betHash(kind, root));
        return;
    }
    if (std.mem.eql(u8, name, "cardHash")) {
        try writeFr(w, try cardHash(root));
        return;
    }
    if (std.mem.eql(u8, name, "actionHash")) {
        try writeFr(w, try actionHash(alloc, crypto, root));
        return;
    }
    if (std.mem.eql(u8, name, "decrypt")) {
        try writeDecrypt(alloc, crypto, root, w);
        return;
    }
    return error.UnknownCalcFn;
}

fn writeFr(w: *Writer, value: Fr) !void {
    try w.beginObj();
    try w.okTrue();
    try w.key("value");
    try w.fr(value);
    try w.endObj();
}

fn writeInitialDeck(alloc: std.mem.Allocator, root: std.json.Value, w: *Writer) !void {
    const count = try ops.parseU64(root.object.get("count") orelse return error.MissingCount);
    const decks = if (root.object.get("decks")) |raw| try ops.parseU64(raw) else 1;
    if (count == 0 or decks == 0 or count * decks > 512) return error.InvalidDeck;
    const n: usize = @intCast(count * decks);
    const deck = try alloc.alloc(Ciphertext, n);
    defer alloc.free(deck);
    if (decks == 1) {
        zk.fillIdentity(deck);
    } else {
        zk.fillRepeatedRank(deck, @intCast(decks), @intCast(count));
    }
    try w.beginObj();
    try w.okTrue();
    try w.key("deck");
    try w.cts(deck);
    try w.endObj();
}

fn takeDeck(alloc: std.mem.Allocator, root: std.json.Value) !ops.CtList {
    return ops.parseCtList(alloc, root.object.get("deck") orelse return error.MissingDeck);
}

fn takeKeys(root: std.json.Value) !ops.PointList {
    return ops.parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
}

fn takePoint(root: std.json.Value, name: []const u8) !PublicKey {
    return ops.parsePoint(root.object.get(name) orelse return error.MissingPublicKey);
}

fn shuffleHash(alloc: std.mem.Allocator, crypto: *const Crypto, kind: Kind, root: std.json.Value) !Fr {
    const deck_n = try takeDeck(alloc, root);
    defer alloc.free(deck_n.ptr[0..deck_n.len]);
    const keys_n = try takeKeys(root);
    const deck = deck_n.ptr[0..deck_n.len];
    const keys = keys_n.buf[0..keys_n.len];
    return switch (kind) {
        .slots => blk: {
            if (keys.len != 2) return error.KeyCount;
            break :blk poseidon.hash(&.{ crypto.hashCiphertexts(deck), hash.hashPublicKeys2(keys) });
        },
        .craps => craps.shuffleHash(crypto, deck, keys),
        else => crypto.shuffleHash(deck, keys),
    };
}

fn shareHash(alloc: std.mem.Allocator, crypto: *const Crypto, kind: Kind, root: std.json.Value) !Fr {
    const deck_n = try takeDeck(alloc, root);
    defer alloc.free(deck_n.ptr[0..deck_n.len]);
    const pk = try takePoint(root, "publicKey");
    const others_n = try takeKeys(root);
    const deck = deck_n.ptr[0..deck_n.len];
    const others = others_n.buf[0..others_n.len];
    return switch (kind) {
        .poker => blk: {
            const mask = try ops.parseU64(root.object.get("cardMask") orelse return error.MissingCardMask);
            if (others.len != poker.SHARE_OTHERS) return error.ShareOthersCount;
            break :blk poker.shareHash(crypto, deck, mask, pk, others);
        },
        .war => war.shareHash(crypto, deck, pk, others),
        .baccarat => baccarat.shareHash(crypto, deck, pk, others),
        .blackjack => blackjack.shareHash(crypto, deck, pk, others),
        .roulette => blk: {
            if (others.len != 11) return error.ShareOthersCount;
            break :blk roulette.shareHash(crypto, deck, pk, others);
        },
        .keno => blk: {
            if (others.len != 11) return error.ShareOthersCount;
            break :blk keno.shareHash(crypto, deck, pk, others);
        },
        .slots => blk: {
            if (others.len < 1) return error.ShareOthersCount;
            break :blk slot.shareHash(crypto, deck, pk, others);
        },
        .bingo => crypto.shareHash(deck, pk, others),
        else => crypto.shareHash(deck, pk, others),
    };
}

fn shareOutputHash(alloc: std.mem.Allocator, kind: Kind, root: std.json.Value) !Fr {
    var grid = try parseGrid(alloc, root.object.get("ciphertexts") orelse return error.MissingCiphertexts);
    defer grid.deinit(alloc);
    const values = try flattenGrid(alloc, grid.rows);
    defer alloc.free(values);
    const n_actual: u32 = @intCast(try ops.parseU64(root.object.get("nActualPlayers") orelse return error.MissingNActual));
    return switch (kind) {
        .poker => poker.computeShareOutputHash(values, n_actual),
        .war => war.computeShareOutputHash(values, n_actual),
        .baccarat => baccarat.computeShareOutputHash(values, n_actual),
        .blackjack => poly.hashRecipientMajor(values, 7, 16, 8, n_actual),
        .roulette => poly.hashRecipientMajor(values, 11, 1, 12, n_actual),
        .craps => craps.computeShareOutputHash(values, n_actual),
        .keno => keno.computeShareOutputHash(values, n_actual),
        .bingo => bingo.computeShareOutputHash(values, n_actual),
        .slots => blk: {
            const reels: u32 = @intCast(try ops.parseU64(root.object.get("nReels") orelse return error.MissingReels));
            break :blk slot.computeShareOutputHash(values, reels, n_actual);
        },
    };
}

fn showdownHash(alloc: std.mem.Allocator, crypto: *const Crypto, kind: Kind, root: std.json.Value) !Fr {
    const keys_n = try takeKeys(root);
    const keys = keys_n.buf[0..keys_n.len];
    const player_index = try ops.parseFr(root.object.get("playerIndex") orelse return error.MissingPlayerIndex);
    const cards_n = try ops.parseCtList(alloc, root.object.get("cards") orelse return error.MissingCards);
    defer alloc.free(cards_n.ptr[0..cards_n.len]);
    var grid = try parseGrid(alloc, root.object.get("partials") orelse return error.MissingPartials);
    defer grid.deinit(alloc);
    const cards = cards_n.ptr[0..cards_n.len];
    const partials = grid.rows;
    return switch (kind) {
        .poker => blk: {
            var masks: [16]Fr = undefined;
            const n = try ops.parseFrListCount(root.object.get("potMasks") orelse return error.MissingPotMasks, &masks);
            break :blk poker.showdownHash(crypto, masks[0..n], keys, player_index, cards, partials);
        },
        .war => war.showdownHash(crypto, keys, player_index, cards, partials),
        .baccarat => baccarat.showdownHash(crypto, keys, player_index, cards, partials),
        .blackjack => blk: {
            const player_cards = try ops.parseU64(root.object.get("playerCardCount") orelse return error.MissingCardCount);
            const dealer_cards = try ops.parseU64(root.object.get("dealerCardCount") orelse return error.MissingCardCount);
            break :blk blackjack.showdownHash(crypto, keys, player_index, cards, partials, player_cards, dealer_cards);
        },
        .roulette, .keno => blk: {
            const bets_n = try ops.parseCtList(alloc, root.object.get("bets") orelse return error.MissingBets);
            defer alloc.free(bets_n.ptr[0..bets_n.len]);
            const n_actual = try ops.parseU64(root.object.get("nActualBets") orelse return error.MissingNActual);
            const bets = bets_n.ptr[0..bets_n.len];
            break :blk if (kind == .roulette)
                roulette.showdownHash(crypto, keys, player_index, cards, partials, bets, n_actual)
            else
                keno.showdownHash(crypto, keys, player_index, cards, partials, bets, n_actual);
        },
        .craps => blk: {
            const bets_n = try ops.parseCtList(alloc, root.object.get("bets") orelse return error.MissingBets);
            defer alloc.free(bets_n.ptr[0..bets_n.len]);
            const n_actual = try ops.parseU64(root.object.get("nActualBets") orelse return error.MissingNActual);
            const phase = try ops.parseU64(root.object.get("phase") orelse return error.MissingPhase);
            const point = try ops.parseU64(root.object.get("point") orelse return error.MissingPoint);
            break :blk craps.showdownHash(crypto, keys, player_index, cards, partials, bets_n.ptr[0..bets_n.len], n_actual, phase, point);
        },
        .slots => blk: {
            const bet = try ops.parseCt(root.object.get("ciphertextBet") orelse return error.MissingBet);
            break :blk slot.showdownHash(crypto, keys, player_index, cards, partials, bet);
        },
        .bingo => blk: {
            const cells_n = try ops.parseCtList(alloc, root.object.get("ciphertextCardCells") orelse return error.MissingCells);
            defer alloc.free(cells_n.ptr[0..cells_n.len]);
            const n_called = try ops.parseU64(root.object.get("nCalled") orelse return error.MissingNCalled);
            const pattern = if (root.object.get("patternId")) |raw| try ops.parseU64(raw) else null;
            break :blk bingo.showdownHash(crypto, keys, player_index, cards, partials, cells_n.ptr[0..cells_n.len], n_called, pattern);
        },
    };
}

fn betHash(kind: Kind, root: std.json.Value) !Fr {
    const pk = try takePoint(root, "publicKey");
    const house = try takePoint(root, "house");
    const n_actual = try ops.parseU64(root.object.get("nActualBets") orelse return error.MissingNActual);
    return switch (kind) {
        .roulette => roulette.betHash(pk, house, n_actual),
        .craps => craps.betHash(pk, house, n_actual),
        .keno => keno.betHash(pk, house, n_actual),
        else => error.BetUnsupported,
    };
}

fn cardHash(root: std.json.Value) !Fr {
    const pk = try takePoint(root, "publicKey");
    const n_cells = try ops.parseU64(root.object.get("nCells") orelse return error.MissingCells);
    return bingo.cardHash(pk, n_cells);
}

fn writeDecrypt(alloc: std.mem.Allocator, crypto: *const Crypto, root: std.json.Value, w: *Writer) !void {
    const sk = try ops.parseFr(root.object.get("privateKey") orelse return error.MissingPrivateKey);
    const cards_n = try ops.parseCtList(alloc, root.object.get("cards") orelse return error.MissingCards);
    defer alloc.free(cards_n.ptr[0..cards_n.len]);
    var grid = try parseGrid(alloc, root.object.get("partials") orelse return error.MissingPartials);
    defer grid.deinit(alloc);
    const cards = cards_n.ptr[0..cards_n.len];
    const out = try alloc.alloc(u64, cards.len);
    defer alloc.free(out);
    try crypto.decryptCards(sk, cards, grid.rows, out);
    try w.beginObj();
    try w.okTrue();
    try w.key("cardIndices");
    try w.u64s(out);
    try w.endObj();
}

fn actionHash(alloc: std.mem.Allocator, crypto: *const Crypto, root: std.json.Value) !Fr {
    const keys_n = try takeKeys(root);
    const cards_n = try ops.parseCtList(alloc, root.object.get("cards") orelse return error.MissingCards);
    defer alloc.free(cards_n.ptr[0..cards_n.len]);
    var grid = try parseGrid(alloc, root.object.get("partials") orelse return error.MissingPartials);
    defer grid.deinit(alloc);
    const card_count = try ops.parseU64(root.object.get("cardCount") orelse return error.MissingCardCount);
    const can_split = ops.parseBool(root.object.get("canSplit"), false);
    const hit_soft_17 = ops.parseBool(root.object.get("hitSoft17"), false);
    const is_dealer = ops.parseBool(root.object.get("isDealer"), false);
    return blackjack.actionHash(
        crypto,
        keys_n.buf[0..keys_n.len],
        cards_n.ptr[0..cards_n.len],
        grid.rows,
        card_count,
        can_split,
        hit_soft_17,
        is_dealer,
    );
}

fn parseGrid(alloc: std.mem.Allocator, value: std.json.Value) !Grid {
    if (value != .array) return error.InvalidPartials;
    const n_rows = value.array.items.len;
    if (n_rows == 0 or n_rows > 16) return error.InvalidPartials;
    var total: usize = 0;
    var widths: [16]usize = undefined;
    for (value.array.items, 0..) |row, r| {
        if (row != .array) return error.InvalidPartials;
        widths[r] = row.array.items.len;
        total += widths[r];
    }
    const flat = try alloc.alloc(Ciphertext, total);
    errdefer alloc.free(flat);
    const rows = try alloc.alloc([]const Ciphertext, n_rows);
    errdefer alloc.free(rows);
    var off: usize = 0;
    for (value.array.items, 0..) |row, r| {
        const n = try ops.parseCtListInto(row, flat[off .. off + widths[r]]);
        rows[r] = flat[off .. off + n];
        off += n;
    }
    return .{ .flat = flat, .rows = rows };
}

fn flattenGrid(alloc: std.mem.Allocator, rows: []const []const Ciphertext) ![]Fr {
    var n: usize = 0;
    for (rows) |row| n += row.len * 4;
    const out = try alloc.alloc(Fr, n);
    var i: usize = 0;
    for (rows) |row| {
        for (row) |ct| {
            const limbs = ct.limbs();
            inline for (0..4) |k| {
                out[i] = limbs[k];
                i += 1;
            }
        }
    }
    return out;
}
