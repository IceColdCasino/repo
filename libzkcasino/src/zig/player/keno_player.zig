const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const poly = @import("../crypto/poly_hash.zig");
const base = @import("player_base.zig");
const keno_eval = @import("keno_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;
pub const MAX_PLAYERS: usize = 12;
pub const TOTAL_CARDS: usize = keno_eval.KENO_DRAW;

pub fn betHash(pk: PublicKey, house: PublicKey, n_actual: u64) Fr {
    return poseidon.hash(&.{ hash.hashPublicKeys2(&.{ pk, house }), Fr.fromU64(n_actual) });
}

pub fn shareHash(crypto: *const Crypto, cts: []const Ciphertext, pk: PublicKey, others: []const PublicKey) Fr {
    var keys: [12]PublicKey = undefined;
    keys[0] = pk;
    @memcpy(keys[1 .. 1 + others.len], others);
    return poseidon.hash(&.{ crypto.hashCiphertexts(cts), hash.hashPublicKeys12(keys[0..12]) });
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    bets: []const Ciphertext,
    n_actual_bets: u64,
) Fr {
    const h1 = hash.hashPublicKeys12(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    return poseidon.hash(&.{ h1, player_index, h2, crypto.hashCiphertexts(bets), Fr.fromU64(n_actual_bets) });
}

pub fn commitSpots(crypto: *const Crypto, spots: []const u8, pks: []const PublicKey, randomness: []const []const Fr, out: [][]Ciphertext) void {
    var padded: [20]u8 = undefined;
    const all = keno_eval.padSpots(spots, &padded);
    var p: usize = 0;
    while (p < pks.len) : (p += 1) {
        var b: usize = 0;
        while (b < all.len) : (b += 1) {
            out[p][b] = crypto.encryptScalar(all[b], pks[p], randomness[p][b]);
        }
    }
}

pub const evaluate = keno_eval.evaluate;
pub const padSpots = keno_eval.padSpots;

pub fn computeShareOutputHash(values: []const Fr, n_actual: u32) Fr {
    return poly.hashRecipientMajor(values, 11, 20, 12, n_actual);
}

pub fn computeShowdownOutputHash(matches: u64, coefficient: Fr) Fr {
    return Fr.fromU64(matches).add(Fr.one()).mul(coefficient);
}

pub const Player = struct {
    table: table.TablePlayer,

    pub fn init(alloc: std.mem.Allocator, engine: *table.Engine, crypto: *Crypto) Player {
        return .{ .table = .init(alloc, engine, crypto) };
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
        return self.table.shuffleProve(.shuffle_1_deck_80_main, deck, keys);
    }

    pub fn shareProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey, n_actual: u32) !table.ShareOut {
        const h = shareHash(self.table.crypto, deck, self.table.publicKey(), keys);
        return self.table.linearShareProve(.keno_share_hashout_main, deck, keys, n_actual, h);
    }

    pub fn betProve(self: *Player, house: PublicKey, spots: []const u8) !struct { proof: table.Proof, n_actual: u32 } {
        var padded: [20]u8 = undefined;
        const all = padSpots(spots, &padded);
        const n_actual: u32 = @intCast(spots.len);
        const h = betHash(self.table.publicKey(), house, n_actual);
        const rand = try table.allocFrGrid(self.table.alloc, 2, 20, &self.table.crypto.rng);
        defer self.table.alloc.free(rand.rows);
        defer self.table.alloc.free(rand.flat);
        var rand_const: [2][]const Fr = .{ rand.rows[0], rand.rows[1] };
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldPoints("publicKeys", &.{house});
        try j.fieldU64("nActualBets", n_actual);
        try j.fieldBytes("plaintextBets", all);
        try j.fieldFrGrid("randomness", &rand_const);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const proof = try self.table.proveJson(.keno_bet_main, json);
        return .{ .proof = proof, .n_actual = n_actual };
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        bets: []const Ciphertext,
        spots: []const u8,
        n_actual_bets: u32,
    ) !struct { proof: table.Proof, matches: u32 } {
        const idx = self.table.indexOfSelf(public_keys);
        var coeffs: [1]Fr = undefined;
        self.table.fillCoeffs(&coeffs);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, bets, n_actual_bets);
        var draw: [20]u64 = undefined;
        try self.table.crypto.decryptCards(self.table.privateKey(), cards, partials, &draw);
        var padded: [20]u8 = undefined;
        const all = padSpots(spots, &padded);
        var draw_u8: [20]u8 = undefined;
        for (draw, 0..) |d, i| draw_u8[i] = @intCast(d);
        const matches = evaluate(&draw_u8, all, n_actual_bets);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldCts("ciphertextBets", bets);
        try j.fieldU64("nActualBets", n_actual_bets);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", &draw);
        try j.fieldBytes("plaintextBets", all);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const proof = try self.table.proveJson(.keno_showdown_hashout_main, json);
        return .{ .proof = proof, .matches = matches };
    }
};
