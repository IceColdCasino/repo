const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const poly = @import("../crypto/poly_hash.zig");
const base = @import("player_base.zig");
const bingo_eval = @import("bingo_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;

pub fn cardHash(pk: PublicKey, n_cells: u64) Fr {
    return poseidon.hash(&.{ pk.x, pk.y, Fr.fromU64(n_cells) });
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    card_cells: []const Ciphertext,
    n_called: u64,
    pattern_id: ?u64,
) Fr {
    const h1 = hash.hashPublicKeys12(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    const card_h = crypto.hashCiphertexts(card_cells);
    if (pattern_id) |pid| {
        return poseidon.hash(&.{ h1, player_index, h2, card_h, Fr.fromU64(pid), Fr.fromU64(n_called) });
    }
    return poseidon.hash(&.{ h1, player_index, h2, card_h, Fr.fromU64(n_called) });
}

pub fn commitCard(crypto: *const Crypto, cells: []const u8, pk: PublicKey, randomness: []const Fr, out: []Ciphertext) void {
    for (cells, 0..) |cell, i| {
        out[i] = crypto.encryptScalar(cell, pk, randomness[i]);
    }
}

pub const evaluate75 = bingo_eval.evaluate75;
pub const evaluate90 = bingo_eval.evaluate90;
pub const sample75 = bingo_eval.sample75;

pub fn computeShareOutputHash(values: []const Fr, n_actual: u32) Fr {
    return poly.hashRecipientMajor(values, 11, 5, 12, n_actual);
}

pub const Player = struct {
    table: table.TablePlayer,
    variant: u32 = 75,

    pub fn init(alloc: std.mem.Allocator, engine: *table.Engine, crypto: *Crypto, variant: u32) Player {
        return .{ .table = .init(alloc, engine, crypto), .variant = variant };
    }

    pub fn deinit(self: *Player) void {
        self.table.deinit();
    }

    pub fn generateKey(self: *Player) void {
        self.table.generateKey();
    }

    pub fn registerProve(self: *Player) !table.RegisterOut {
        return self.table.registerProve();
    }

    pub fn shuffleProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey) !table.ShuffleOut {
        return self.table.shuffleProve(if (self.variant == 90) .shuffle_1_deck_90_main else .shuffle_1_deck_75_main, deck, keys);
    }

    pub fn shareProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey, n_actual: u32) !table.ShareOut {
        const h = self.table.crypto.shareHash(deck, self.table.publicKey(), keys);
        return self.table.linearShareProve(.bingo_share_hashout_main, deck, keys, n_actual, h);
    }

    pub fn cardProve(self: *Player, cells: []const u8) !table.Proof {
        const h = cardHash(self.table.publicKey(), cells.len);
        const rand = try self.table.alloc.alloc(Fr, cells.len);
        defer self.table.alloc.free(rand);
        self.table.crypto.generateShuffleRandomness(cells.len, rand);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldBytes("plaintextCells", cells);
        try j.fieldFrs("randomness", rand);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(if (self.variant == 90) .bingo_card_90_main else .bingo_card_75_main, json);
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        card_cells: []const Ciphertext,
        cells: []const u8,
        n_called: u64,
        pattern_id: u64,
    ) !table.Proof {
        const idx = self.table.indexOfSelf(public_keys);
        const need: usize = if (self.variant == 90) 3 else 1;
        var coeff_buf: [3]Fr = undefined;
        self.table.fillCoeffs(coeff_buf[0..need]);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, card_cells, n_called, if (self.variant == 75) pattern_id else null);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldCts("ciphertextCardCells", card_cells);
        try j.fieldU64("nCalled", n_called);
        if (self.variant == 75) try j.fieldU64("patternId", pattern_id);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        const plain = try self.table.alloc.alloc(u64, cards.len);
        defer self.table.alloc.free(plain);
        @memset(plain, 0);
        const called: usize = @intCast(n_called);
        if (called > cards.len) return error.InvalidNCalled;
        try self.table.crypto.decryptCards(self.table.privateKey(), cards[0..called], partials, plain[0..called]);
        try j.fieldU64s("plaintextCards", plain);
        try j.fieldBytes("plaintextCells", cells);
        try j.fieldFrs("coefficients", coeff_buf[0..need]);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(if (self.variant == 90) .bingo_showdown_90_hashout_main else .bingo_showdown_75_hashout_main, json);
    }
};
