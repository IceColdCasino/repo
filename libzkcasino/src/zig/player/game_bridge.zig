//! JSON player ops for every table game except poker (see `bridge_ops.zig`).
//! Dispatches to the existing Zig `Player` types. Groth16 stays in Zig.
const std = @import("std");
const ops = @import("bridge_ops.zig");
const table = @import("table_player.zig");
const baby = @import("../crypto/babyjub.zig");
const prove = @import("../prove.zig");
const war = @import("war_player.zig");
const baccarat = @import("baccarat_player.zig");
const blackjack = @import("blackjack_player.zig");
const roulette = @import("roulette_player.zig");
const craps = @import("craps_player.zig");
const keno = @import("keno_player.zig");
const bingo = @import("bingo_player.zig");
const slot = @import("slot_player.zig");

const Fr = table.Fr;
const Crypto = table.Crypto;
const Ciphertext = table.Ciphertext;
const PublicKey = table.PublicKey;
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

const PlayerU = union(enum) {
    war: war.Player,
    baccarat: baccarat.Player,
    blackjack: blackjack.Player,
    roulette: roulette.Player,
    craps: craps.Player,
    keno: keno.Player,
    bingo: bingo.Player,
    slot: slot.Player,
};

pub const Session = struct {
    alloc: std.mem.Allocator,
    engine: *table.Engine,
    crypto: *Crypto,
    kind: Kind,
    variant: u32,
    sealed_buf: [16]Fr = undefined,
    sealed_len: usize = 0,
    player: PlayerU,

    pub fn init(alloc: std.mem.Allocator, engine: *table.Engine, kind: Kind, variant: u32) !Session {
        if (kind == .poker) return error.UsePokerBridge;
        const shoe = catalogSize(kind, variant);
        const crypto = try alloc.create(Crypto);
        errdefer alloc.destroy(crypto);
        crypto.* = try Crypto.init(alloc, shoe, 0);
        errdefer crypto.deinit(alloc);

        const player: PlayerU = switch (kind) {
            .war => blk: {
                var p = war.Player.init(alloc, engine, crypto);
                p.shuffle_id = shoeShuffleId(shoeDecks(kind, variant));
                break :blk .{ .war = p };
            },
            .baccarat => blk: {
                var p = baccarat.Player.init(alloc, engine, crypto);
                p.shuffle_id = shoeShuffleId(shoeDecks(kind, variant));
                break :blk .{ .baccarat = p };
            },
            .blackjack => blk: {
                var p = blackjack.Player.init(alloc, engine, crypto);
                p.shuffle_id = shoeShuffleId(shoeDecks(kind, variant));
                break :blk .{ .blackjack = p };
            },
            .roulette => .{ .roulette = roulette.Player.init(alloc, engine, crypto, variant != 38) },
            .craps => .{ .craps = craps.Player.init(alloc, engine, crypto) },
            .keno => .{ .keno = keno.Player.init(alloc, engine, crypto) },
            .bingo => .{ .bingo = bingo.Player.init(alloc, engine, crypto, if (variant == 90) 90 else 75) },
            .slots => .{ .slot = slot.Player.init(alloc, engine, crypto, if (variant == 5) 5 else 3) },
            .poker => unreachable,
        };
        return .{
            .alloc = alloc,
            .engine = engine,
            .crypto = crypto,
            .kind = kind,
            .variant = variant,
            .player = player,
        };
    }

    pub fn deinit(self: *Session) void {
        switch (self.player) {
            inline else => |*p| p.deinit(),
        }
        self.crypto.deinit(self.alloc);
        self.alloc.destroy(self.crypto);
    }

    fn tablePtr(self: *Session) *table.TablePlayer {
        return switch (self.player) {
            inline else => |*p| &p.table,
        };
    }
};

pub fn kindName(kind: Kind) []const u8 {
    return switch (kind) {
        .poker => "poker",
        .baccarat => "baccarat",
        .blackjack => "blackjack",
        .war => "war",
        .roulette => "roulette",
        .craps => "craps",
        .keno => "keno",
        .slots => "slots",
        .bingo => "bingo",
    };
}

pub fn dispatch(self: *Session, payload: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, self.alloc, payload, .{});
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidPayload;
    const op = ops.asDec(root.object.get("op") orelse return error.MissingOp);

    var w = Writer.init(self.alloc);
    errdefer w.deinit();

    if (std.mem.eql(u8, op, "ping")) {
        try w.beginObj();
        try w.okTrue();
        try w.key("backend");
        try w.quote("zig");
        try w.key("game");
        try w.quote(kindName(self.kind));
        try w.endObj();
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "key")) {
        try writeKey(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "register")) {
        try writeRegister(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "shuffle")) {
        try writeShuffle(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "share")) {
        try writeShare(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "showdown")) {
        try writeShowdown(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "bet")) {
        try writeBet(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "action")) {
        try writeAction(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "card")) {
        try writeCard(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "decrypt")) {
        try writeDecrypt(self, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "calc")) {
        const calc = @import("calc.zig");
        try calc.run(self.alloc, self.crypto, @intFromEnum(self.kind), root, &w);
        return w.toOwned();
    }
    return error.UnknownPlayerOp;
}

fn shoeDecks(kind: Kind, variant: u32) u32 {
    if (variant == 1 or variant == 6 or variant == 8) return variant;
    return switch (kind) {
        .war, .blackjack => 6,
        else => 1,
    };
}

fn shoeShuffleId(decks: u32) prove.CircuitId {
    return switch (decks) {
        8 => .shuffle_8_deck_52_main,
        6 => .shuffle_6_deck_52_main,
        else => .shuffle_1_deck_52_main,
    };
}

fn catalogSize(kind: Kind, variant: u32) usize {
    return switch (kind) {
        .poker => 52,
        .baccarat, .blackjack, .war => 52 * shoeDecks(kind, variant),
        .roulette => if (variant == 38) 38 else 37,
        .craps => 6,
        .keno => 80,
        .slots => 22,
        .bingo => if (variant == 90) 90 else 75,
    };
}

fn loadOrGenKey(self: *Session, root: std.json.Value) !void {
    const t = self.tablePtr();
    if (root.object.get("privateKey")) |raw| {
        const sk = try ops.parseFr(raw);
        if (sk.cmpNormal(Fr.fromU64(1024)) <= 0) return error.PrivateKeyTooSmall;
        t.loadKey(.{ .private_key = sk, .public_key = baby.mulBase8(sk) });
        return;
    }
    if (t.key == null) t.generateKey();
}

fn requireKey(self: *Session, root: std.json.Value) !void {
    const t = self.tablePtr();
    if (root.object.get("privateKey")) |raw| {
        const sk = try ops.parseFr(raw);
        if (sk.cmpNormal(Fr.fromU64(1024)) <= 0) return error.PrivateKeyTooSmall;
        t.loadKey(.{ .private_key = sk, .public_key = baby.mulBase8(sk) });
        return;
    }
    if (t.key == null) return error.KeyNotGenerated;
}

fn applyActionCoeffs(self: *Session, root: std.json.Value) !void {
    const raw = root.object.get("coefficients") orelse return error.MissingHostCoefficients;
    const n = try ops.parseFrListCount(raw, self.sealed_buf[0..2]);
    if (n != 2) return error.FrListSize;
    if (self.sealed_buf[0].eql(Fr.zero())) return error.ZeroCoefficient;
    self.sealed_len = 2;
    self.tablePtr().setSealed(self.sealed_buf[0..2]);
}

fn applyCoeffs(self: *Session, root: std.json.Value, need: usize) !void {
    const raw = root.object.get("coefficients") orelse return error.MissingHostCoefficients;
    if (need == 0 or need > self.sealed_buf.len) return error.SealedCoefficientCount;
    const n = try ops.parseFrListCount(raw, self.sealed_buf[0..need]);
    if (n != need) return error.FrListSize;
    for (self.sealed_buf[0..need]) |c| {
        if (c.eql(Fr.zero())) return error.ZeroCoefficient;
    }
    self.sealed_len = need;
    self.tablePtr().setSealed(self.sealed_buf[0..need]);
}

fn writeKey(self: *Session, root: std.json.Value, w: *Writer) !void {
    try loadOrGenKey(self, root);
    const t = self.tablePtr();
    const key = t.key orelse return error.KeyNotGenerated;
    try w.beginObj();
    try w.okTrue();
    try w.key("privateKey");
    try w.fr(key.private_key);
    try w.key("publicKey");
    try w.point(key.public_key);
    try w.key("padding");
    try w.ct(t.padding());
    try w.endObj();
}

fn writeRegister(self: *Session, root: std.json.Value, w: *Writer) !void {
    try loadOrGenKey(self, root);
    var out = try switch (self.player) {
        inline else => |*p| p.registerProve(),
    };
    defer out.deinit();
    const t = self.tablePtr();
    try w.beginObj();
    try w.okTrue();
    try w.embedProof(out.proof.proof_json, out.proof.public_json);
    try w.key("privateKey");
    try w.fr(t.privateKey());
    try w.key("publicKey");
    try w.point(t.publicKey());
    try w.key("padding");
    try w.ct(out.padding);
    try w.endObj();
}

fn writeShuffle(self: *Session, root: std.json.Value, w: *Writer) !void {
    try loadOrGenKey(self, root);
    const keys_n = try ops.parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    const keys = keys_n.buf[0..keys_n.len];

    if (self.kind == .slots) {
        const reels_val = root.object.get("reels") orelse root.object.get("deck") orelse return error.MissingDeck;
        var reel_storage: [5][22]Ciphertext = undefined;
        var reel_slices: [5][]const Ciphertext = undefined;
        const n_reels = try parseReelGrid(reels_val, self.player.slot.n_reels, &reel_storage, &reel_slices);
        var out = try self.player.slot.shuffleProve(reel_slices[0..n_reels], keys);
        defer out.deinit();
        try w.beginObj();
        try w.okTrue();
        try w.embedProof(out.proof.proof_json, out.proof.public_json);
        try w.key("permutationHash");
        try w.fr(out.permutation_hash);
        try w.key("deck");
        try w.cts(out.deck);
        try w.key("reels");
        try writeReelGrid(w, out.deck, n_reels, 22);
        try w.endObj();
        return;
    }

    const deck_n = try ops.parseCtList(self.alloc, root.object.get("deck") orelse root.object.get("dice") orelse return error.MissingDeck);
    defer self.alloc.free(deck_n.ptr[0..deck_n.len]);
    const deck = deck_n.ptr[0..deck_n.len];

    var out = try switch (self.player) {
        .war => |*p| p.shuffleProve(deck, keys),
        .baccarat => |*p| p.shuffleProve(deck, keys),
        .blackjack => |*p| p.shuffleProve(deck, keys),
        .roulette => |*p| p.shuffleProve(deck, keys),
        .craps => |*p| p.shuffleProve(deck, keys),
        .keno => |*p| p.shuffleProve(deck, keys),
        .bingo => |*p| p.shuffleProve(deck, keys),
        .slot => return error.MissingReels,
    };
    defer out.deinit();

    try w.beginObj();
    try w.okTrue();
    try w.embedProof(out.proof.proof_json, out.proof.public_json);
    try w.key("permutationHash");
    try w.fr(out.permutation_hash);
    try w.key("deck");
    try w.cts(out.deck);
    if (self.kind == .craps and out.deck.len == 12) {
        try w.key("dice");
        try writeReelGrid(w, out.deck, 2, 6);
    }
    try w.endObj();
}

fn writeShare(self: *Session, root: std.json.Value, w: *Writer) !void {
    try requireKey(self, root);
    const deck_n = try ops.parseCtList(self.alloc, root.object.get("deck") orelse return error.MissingDeck);
    defer self.alloc.free(deck_n.ptr[0..deck_n.len]);
    const deck = deck_n.ptr[0..deck_n.len];
    const keys_n = try ops.parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    const keys = keys_n.buf[0..keys_n.len];
    const n_actual: u32 = @intCast(try ops.parseU64(root.object.get("nActualPlayers") orelse return error.MissingNActual));

    if (self.kind == .slots) {
        const coin: u64 = if (root.object.get("coinBet")) |raw| try ops.parseU64(raw) else 1;
        var out = try self.player.slot.shareProve(deck, keys, coin);
        defer out.deinit();
        try w.beginObj();
        try w.okTrue();
        try w.embedProof(out.proof.proof_json, out.proof.public_json);
        try w.key("ciphertexts");
        try w.ctGrid(out.rows);
        try w.key("coinBet");
        try w.writeU64(coin);
        try w.endObj();
        return;
    }

    var out = try switch (self.player) {
        .war => |*p| p.shareProve(deck, keys, n_actual),
        .baccarat => |*p| p.shareProve(deck, keys, n_actual),
        .blackjack => |*p| p.shareProveChunk(deck, keys, n_actual),
        .roulette => |*p| p.shareProve(deck, keys, n_actual),
        .craps => |*p| p.shareProve(deck, keys, n_actual),
        .keno => |*p| p.shareProve(deck, keys, n_actual),
        .bingo => |*p| p.shareProve(deck, keys, n_actual),
        .slot => unreachable,
    };
    defer out.deinit();

    try w.beginObj();
    try w.okTrue();
    try w.embedProof(out.proof.proof_json, out.proof.public_json);
    try w.key("ciphertexts");
    try w.ctGrid(out.rows);
    try w.endObj();
}

fn writeShowdown(self: *Session, root: std.json.Value, w: *Writer) !void {
    try requireKey(self, root);
    const keys_n = try ops.parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    const keys = keys_n.buf[0..keys_n.len];
    const cards_n = try ops.parseCtList(self.alloc, root.object.get("cards") orelse return error.MissingCards);
    defer self.alloc.free(cards_n.ptr[0..cards_n.len]);
    const cards = cards_n.ptr[0..cards_n.len];
    var grid = try parseCtGridAlloc(self.alloc, root.object.get("partials") orelse return error.MissingPartials);
    defer grid.deinit(self.alloc);
    const partials = grid.rows;

    try w.beginObj();
    try w.okTrue();

    switch (self.player) {
        .war => |*p| {
            try applyCoeffs(self, root, 1);
            var out = try p.showdownProve(keys, cards, partials);
            defer out.proof.deinit();
            try w.embedProof(out.proof.proof_json, out.proof.public_json);
            try w.key("winner");
            try w.writeU64(out.winner);
            try w.key("plaintextCards");
            try w.u64s(&out.plaintext);
        },
        .baccarat => |*p| {
            try applyCoeffs(self, root, 1);
            var out = try p.showdownProve(keys, cards, partials);
            defer out.proof.deinit();
            try w.embedProof(out.proof.proof_json, out.proof.public_json);
            try w.key("winner");
            try w.writeU64(out.winner);
            try w.key("plaintextCards");
            try w.u64s(&out.plaintext);
        },
        .blackjack => |*p| {
            try applyCoeffs(self, root, 1);
            const player_n = try ops.parseU64(root.object.get("playerCardCount") orelse return error.MissingPlayerCardCount);
            const dealer_n = try ops.parseU64(root.object.get("dealerCardCount") orelse return error.MissingDealerCardCount);
            var pt_buf: [32]u64 = undefined;
            const pt = try parseU64ListInto(root.object.get("plaintextCards"), &pt_buf);
            const plaintext = if (pt.len > 0) pt else blk: {
                try self.crypto.decryptCards(self.tablePtr().privateKey(), cards, partials, pt_buf[0..cards.len]);
                break :blk pt_buf[0..cards.len];
            };
            var proof = try p.showdownProve(keys, cards, partials, plaintext, player_n, dealer_n);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
        },
        .roulette => |*p| {
            try applyCoeffs(self, root, 12);
            const enc = try ops.parseCtList(self.alloc, root.object.get("ciphertextBets") orelse root.object.get("encBets") orelse return error.MissingBets);
            defer self.alloc.free(enc.ptr[0..enc.len]);
            var bets: [12][2]u32 = undefined;
            const n_bets = try parseBetPairs(root.object.get("bets") orelse return error.MissingBets, &bets);
            const n_actual: u32 = @intCast(if (root.object.get("nActualBets")) |raw| try ops.parseU64(raw) else n_bets);
            var proof = try p.showdownProve(keys, cards, partials, enc.ptr[0..enc.len], bets[0..n_bets], n_actual);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
        },
        .craps => |*p| {
            try applyCoeffs(self, root, 14);
            const enc = try ops.parseCtList(self.alloc, root.object.get("ciphertextBets") orelse root.object.get("encBets") orelse return error.MissingBets);
            defer self.alloc.free(enc.ptr[0..enc.len]);
            var bets: [12][2]u32 = undefined;
            const n_bets = try parseBetPairs(root.object.get("bets") orelse return error.MissingBets, &bets);
            const n_actual: u32 = @intCast(if (root.object.get("nActualBets")) |raw| try ops.parseU64(raw) else n_bets);
            const phase = try ops.parseU64(root.object.get("phase") orelse return error.MissingPhase);
            const point = try ops.parseU64(root.object.get("point") orelse return error.MissingPoint);
            var proof = try p.showdownProve(keys, cards, partials, enc.ptr[0..enc.len], bets[0..n_bets], n_actual, phase, point);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
        },
        .keno => |*p| {
            try applyCoeffs(self, root, 1);
            const enc = try ops.parseCtList(self.alloc, root.object.get("ciphertextBets") orelse root.object.get("encBets") orelse return error.MissingBets);
            defer self.alloc.free(enc.ptr[0..enc.len]);
            var spots: [20]u8 = undefined;
            const n_spots = try parseByteList(root.object.get("spots") orelse root.object.get("plaintextSpots") orelse return error.MissingSpots, &spots);
            const n_actual: u32 = @intCast(if (root.object.get("nActualBets")) |raw| try ops.parseU64(raw) else n_spots);
            var out = try p.showdownProve(keys, cards, partials, enc.ptr[0..enc.len], spots[0..n_spots], n_actual);
            defer out.proof.deinit();
            try w.embedProof(out.proof.proof_json, out.proof.public_json);
            try w.key("matches");
            try w.writeU64(out.matches);
        },
        .bingo => |*p| {
            const need: usize = if (p.variant == 90) 3 else 1;
            try applyCoeffs(self, root, need);
            const cells_ct = try ops.parseCtList(self.alloc, root.object.get("ciphertextCardCells") orelse root.object.get("cardCells") orelse return error.MissingCardCells);
            defer self.alloc.free(cells_ct.ptr[0..cells_ct.len]);
            var cells: [27]u8 = undefined;
            const n_cells = try parseByteList(root.object.get("cells") orelse root.object.get("plaintextCells") orelse return error.MissingCells, &cells);
            const n_called = try ops.parseU64(root.object.get("nCalled") orelse return error.MissingNCalled);
            const pattern = if (root.object.get("patternId")) |raw| try ops.parseU64(raw) else 0;
            var proof = try p.showdownProve(keys, cards, partials, cells_ct.ptr[0..cells_ct.len], cells[0..n_cells], n_called, pattern);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
        },
        .slot => |*p| {
            try applyCoeffs(self, root, 1);
            const enc_bet = try ops.parseCt(root.object.get("ciphertextBet") orelse root.object.get("encBet") orelse return error.MissingBet);
            const coin = try ops.parseU64(root.object.get("coinBet") orelse return error.MissingCoinBet);
            var proof = try p.showdownProve(keys, cards, partials, enc_bet, coin);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
        },
    }

    try w.key("publicKey");
    try w.point(self.tablePtr().publicKey());
    try w.endObj();
}

fn writeBet(self: *Session, root: std.json.Value, w: *Writer) !void {
    try requireKey(self, root);
    const house = try ops.parsePoint(root.object.get("house") orelse root.object.get("houseKey") orelse return error.MissingHouse);

    try w.beginObj();
    try w.okTrue();
    switch (self.player) {
        .roulette => |*p| {
            var bets: [12][2]u32 = undefined;
            const n = try parseBetPairs(root.object.get("bets") orelse return error.MissingBets, &bets);
            var proof = try p.betProve(house, bets[0..n]);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
            try w.key("nActualBets");
            try w.writeU64(n);
        },
        .craps => |*p| {
            var bets: [12][2]u32 = undefined;
            const n = try parseBetPairs(root.object.get("bets") orelse return error.MissingBets, &bets);
            var proof = try p.betProve(house, bets[0..n]);
            defer proof.deinit();
            try w.embedProof(proof.proof_json, proof.public_json);
            try w.key("nActualBets");
            try w.writeU64(n);
        },
        .keno => |*p| {
            var spots: [20]u8 = undefined;
            const n = try parseByteList(root.object.get("spots") orelse return error.MissingSpots, &spots);
            var out = try p.betProve(house, spots[0..n]);
            defer out.proof.deinit();
            try w.embedProof(out.proof.proof_json, out.proof.public_json);
            try w.key("nActualBets");
            try w.writeU64(out.n_actual);
        },
        else => return error.BetUnsupported,
    }
    try w.endObj();
}

fn writeAction(self: *Session, root: std.json.Value, w: *Writer) !void {
    if (self.kind != .blackjack) return error.ActionUnsupported;
    try requireKey(self, root);
    const keys_n = try ops.parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    const keys = keys_n.buf[0..keys_n.len];
    const cards_n = try ops.parseCtList(self.alloc, root.object.get("cards") orelse return error.MissingCards);
    defer self.alloc.free(cards_n.ptr[0..cards_n.len]);
    var grid = try parseCtGridAlloc(self.alloc, root.object.get("partials") orelse return error.MissingPartials);
    defer grid.deinit(self.alloc);

    var idx_buf: [13]u64 = undefined;
    const idxs = try parseU64ListInto(root.object.get("sourceIndices"), &idx_buf);
    const card_count = if (root.object.get("cardCount")) |raw| try ops.parseU64(raw) else idxs.len;
    const can_split = ops.parseBool(root.object.get("canSplit"), false);
    const hit_soft_17 = ops.parseBool(root.object.get("hitSoft17"), false);
    const is_dealer = ops.parseBool(root.object.get("isDealer"), false);
    try applyActionCoeffs(self, root);

    var sel_cards: [13]Ciphertext = undefined;
    var sel_partial_store: [16][13]Ciphertext = undefined;
    var sel_partial_rows: [16][]const Ciphertext = undefined;
    const n_sel = padSelect(cards_n.ptr[0..cards_n.len], grid.rows, idxs, card_count, &sel_cards, &sel_partial_store, &sel_partial_rows);

    var pt: [13]u64 = undefined;
    try self.crypto.decryptCards(self.tablePtr().privateKey(), sel_cards[0..n_sel], sel_partial_rows[0..grid.rows.len], pt[0..n_sel]);

    var faces: [13]u32 = undefined;
    var i: usize = 0;
    while (i < card_count) : (i += 1) faces[i] = @intCast(pt[i]);
    const status: u64 = if (is_dealer)
        blackjack.dealerActionStatus(faces[0..card_count], card_count, hit_soft_17)
    else
        blackjack.actionStatus(faces[0..card_count], card_count, can_split);

    var proof = try self.player.blackjack.actionProve(
        keys,
        sel_cards[0..n_sel],
        sel_partial_rows[0..grid.rows.len],
        pt[0..n_sel],
        card_count,
        can_split,
        hit_soft_17,
        is_dealer,
    );
    defer proof.deinit();

    try w.beginObj();
    try w.okTrue();
    try w.embedProof(proof.proof_json, proof.public_json);
    try w.key("status");
    try w.writeU64(status);
    try w.key("publicKey");
    try w.point(self.tablePtr().publicKey());
    try w.endObj();
}

fn writeCard(self: *Session, root: std.json.Value, w: *Writer) !void {
    if (self.kind != .bingo) return error.CardUnsupported;
    try requireKey(self, root);
    var cells: [27]u8 = undefined;
    const n = try parseByteList(root.object.get("cells") orelse return error.MissingCells, &cells);
    var proof = try self.player.bingo.cardProve(cells[0..n]);
    defer proof.deinit();
    try w.beginObj();
    try w.okTrue();
    try w.embedProof(proof.proof_json, proof.public_json);
    try w.endObj();
}

fn writeDecrypt(self: *Session, root: std.json.Value, w: *Writer) !void {
    try requireKey(self, root);
    const cards_n = try ops.parseCtList(self.alloc, root.object.get("cards") orelse return error.MissingCards);
    defer self.alloc.free(cards_n.ptr[0..cards_n.len]);
    const sk = self.tablePtr().privateKey();

    try w.beginObj();
    try w.okTrue();
    try w.key("cardIndices");
    try w.beginArr();
    var first = true;
    if (root.object.get("partials")) |partials_val| {
        var grid = try parseCtGridAlloc(self.alloc, partials_val);
        defer grid.deinit(self.alloc);
        var out: [312]u64 = undefined;
        if (cards_n.len > out.len) return error.TooManyCards;
        try self.crypto.decryptCards(sk, cards_n.ptr[0..cards_n.len], grid.rows, out[0..cards_n.len]);
        for (out[0..cards_n.len]) |idx| {
            if (!first) try w.raw(",");
            first = false;
            try w.writeI64(@intCast(idx));
        }
    } else {
        var i: usize = 0;
        while (i < cards_n.len) : (i += 1) {
            const idx = self.crypto.decryptWithSk(sk, cards_n.ptr[i]);
            if (!first) try w.raw(",");
            first = false;
            try w.writeI64(idx);
        }
    }
    try w.endArr();
    try w.endObj();
}

const CtGrid = struct {
    rows: [][]const Ciphertext,
    row_bufs: [][]Ciphertext,
    flat: []Ciphertext,

    fn deinit(self: *CtGrid, alloc: std.mem.Allocator) void {
        alloc.free(self.rows);
        alloc.free(self.row_bufs);
        alloc.free(self.flat);
    }
};

fn parseCtGridAlloc(alloc: std.mem.Allocator, value: std.json.Value) !CtGrid {
    if (value != .array) return error.InvalidPartials;
    const n_rows = value.array.items.len;
    if (n_rows == 0) return error.InvalidPartials;
    var total: usize = 0;
    var widths: [16]usize = undefined;
    if (n_rows > widths.len) return error.TooManyPartialRows;
    for (value.array.items, 0..) |row, r| {
        if (row != .array) return error.InvalidPartials;
        widths[r] = row.array.items.len;
        total += row.array.items.len;
    }
    const flat = try alloc.alloc(Ciphertext, total);
    errdefer alloc.free(flat);
    const row_bufs = try alloc.alloc([]Ciphertext, n_rows);
    errdefer alloc.free(row_bufs);
    const rows = try alloc.alloc([]const Ciphertext, n_rows);
    errdefer alloc.free(rows);
    var off: usize = 0;
    for (value.array.items, 0..) |row, r| {
        const n = try ops.parseCtListInto(row, flat[off .. off + widths[r]]);
        row_bufs[r] = flat[off .. off + n];
        rows[r] = row_bufs[r];
        off += n;
    }
    return .{ .rows = rows, .row_bufs = row_bufs, .flat = flat };
}

fn parseBetPairs(value: std.json.Value, out: [][2]u32) !usize {
    if (value != .array) return error.InvalidBets;
    if (value.array.items.len > out.len) return error.TooManyBets;
    for (value.array.items, 0..) |item, i| {
        if (item != .array or item.array.items.len < 2) return error.InvalidBet;
        out[i] = .{
            @intCast(try ops.parseU64(item.array.items[0])),
            @intCast(try ops.parseU64(item.array.items[1])),
        };
    }
    return value.array.items.len;
}

fn parseByteList(value: std.json.Value, out: []u8) !usize {
    if (value != .array) return error.InvalidBytes;
    if (value.array.items.len > out.len) return error.TooManyBytes;
    for (value.array.items, 0..) |item, i| out[i] = @intCast(try ops.parseU64(item));
    return value.array.items.len;
}

fn parseU64ListInto(value: ?std.json.Value, out: []u64) ![]u64 {
    const v = value orelse return out[0..0];
    if (v != .array) return error.InvalidU64List;
    if (v.array.items.len > out.len) return error.TooManyU64s;
    for (v.array.items, 0..) |item, i| out[i] = try ops.parseU64(item);
    return out[0..v.array.items.len];
}

fn parseReelGrid(
    value: std.json.Value,
    n_reels: u32,
    storage: *[5][22]Ciphertext,
    slices: *[5][]const Ciphertext,
) !usize {
    if (value != .array) return error.InvalidReels;
    if (value.array.items.len == n_reels and value.array.items[0] == .array) {
        for (value.array.items, 0..) |row, r| {
            const n = try ops.parseCtListInto(row, storage[r][0..]);
            slices[r] = storage[r][0..n];
        }
        return value.array.items.len;
    }
    const n = try ops.parseCtListInto(value, storage[0][0..]);
    if (n % 22 != 0) return error.InvalidReelStops;
    const rows = n / 22;
    if (rows != n_reels) return error.InvalidReels;
    var r: usize = 0;
    var tmp: [5 * 22]Ciphertext = undefined;
    @memcpy(tmp[0..n], storage[0][0..n]);
    while (r < rows) : (r += 1) {
        @memcpy(storage[r][0..22], tmp[r * 22 .. (r + 1) * 22]);
        slices[r] = storage[r][0..22];
    }
    return rows;
}

fn writeReelGrid(w: *Writer, flat: []const Ciphertext, rows: usize, cols: usize) !void {
    const save = w.first;
    try w.beginArr();
    var r: usize = 0;
    while (r < rows) : (r += 1) {
        if (r != 0) try w.raw(",");
        try w.cts(flat[r * cols .. (r + 1) * cols]);
    }
    try w.endArr();
    w.first = save;
}

fn padSelect(
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    idxs: []const u64,
    card_count: u64,
    out_cards: *[13]Ciphertext,
    out_store: *[16][13]Ciphertext,
    out_rows: *[16][]const Ciphertext,
) usize {
    const n: usize = 13;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const src: usize = if (i < idxs.len) @intCast(idxs[i]) else if (card_count > 0 and i < card_count) @intCast(idxs[i]) else 0;
        const use = if (src < cards.len) src else 0;
        out_cards[i] = cards[use];
        var r: usize = 0;
        while (r < partials.len) : (r += 1) {
            const row = partials[r];
            out_store[r][i] = if (use < row.len) row[use] else row[0];
        }
    }
    var r: usize = 0;
    while (r < partials.len) : (r += 1) out_rows[r] = out_store[r][0..n];
    return n;
}
