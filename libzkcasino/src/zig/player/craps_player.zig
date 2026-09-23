const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const poly = @import("../crypto/poly_hash.zig");
const base = @import("player_base.zig");
const eval = @import("craps_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;

pub fn betHash(pk: PublicKey, house: PublicKey, n_actual: u64) Fr {
    return poseidon.hash(&.{ hash.hashPublicKeys2(&.{ pk, house }), Fr.fromU64(n_actual) });
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    bets: []const Ciphertext,
    n_actual_bets: u64,
    phase: u64,
    point: u64,
) Fr {
    const h1 = hash.hashPublicKeys12(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    const table_bind = poseidon.hash(&.{ Fr.fromU64(n_actual_bets), Fr.fromU64(phase), Fr.fromU64(point) });
    return poseidon.hash(&.{ h1, player_index, h2, crypto.hashCiphertexts(bets), table_bind });
}

pub fn shuffleHash(crypto: *const Crypto, dice: []const Ciphertext, keys: []const PublicKey) Fr {
    return crypto.shuffleHash(dice, keys);
}

pub const evaluateCraps = eval.evaluateCraps;
pub const evaluateBet = eval.evaluateBet;
pub const evaluateShowdown = eval.evaluateShowdown;

pub fn computeShareOutputHash(values: []const Fr, n_actual: u32) Fr {
    return poly.hashRecipientMajor(values, 11, 2, 12, n_actual);
}

pub const MAX_CRAPS_BETS: usize = 12;
pub const CRAPS_SHOWDOWN_TERMS: usize = 14;

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

    pub fn shuffleProve(self: *Player, dice: []const Ciphertext, keys: []const PublicKey) !table.ShuffleOut {
        if (dice.len != 12) return error.InvalidDice;
        var padded: [12]PublicKey = undefined;
        const shuffle_keys = hash.padShuffleKeys(keys, &padded);
        const h = shuffleHash(self.table.crypto, dice, keys);

        var matrix: [2 * 6 * 6]u8 = undefined;
        var randomness: [12]Fr = undefined;
        var out: [12]Ciphertext = undefined;
        var d: usize = 0;
        while (d < 2) : (d += 1) {
            const m = matrix[d * 36 .. (d + 1) * 36];
            const r = randomness[d * 6 .. (d + 1) * 6];
            self.table.crypto.generateShufflePermutation(6, m);
            self.table.crypto.generateShuffleRandomness(6, r);
            _ = self.table.crypto.shuffle(
                dice[d * 6 .. (d + 1) * 6],
                shuffle_keys,
                m,
                r,
                out[d * 6 .. (d + 1) * 6],
                6,
            );
        }

        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldCts("dice", dice);
        try j.fieldPoints("publicKeys", shuffle_keys);
        try j.fieldBytes("permutationMatrix", &matrix);
        try j.fieldFrs("randomness", &randomness);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const proof = try self.table.proveJson(.shuffle_2_dice_6_main, json);
        const shuffled = try self.table.alloc.alloc(Ciphertext, 12);
        errdefer self.table.alloc.free(shuffled);
        @memcpy(shuffled, &out);
        return .{
            .proof = proof,
            .deck = shuffled,
            .permutation_hash = Fr.zero(),
            .alloc = self.table.alloc,
        };
    }

    pub fn shareProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey, n_actual: u32) !table.ShareOut {
        const h = self.table.crypto.shareHash(deck, self.table.publicKey(), keys);
        return self.table.linearShareProve(.craps_share_hashout_main, deck, keys, n_actual, h);
    }

    pub fn betProve(self: *Player, house: PublicKey, bets: []const [2]u32) !table.Proof {
        const n_actual: u32 = @intCast(bets.len);
        const h = betHash(self.table.publicKey(), house, n_actual);
        var flat: [24]u64 = undefined;
        @memset(&flat, 0);
        var i: usize = 0;
        while (i < MAX_CRAPS_BETS) : (i += 1) {
            const b = if (i < bets.len) bets[i] else [2]u32{ 0, 0 };
            flat[i * 2] = b[0];
            flat[i * 2 + 1] = b[1];
        }
        const rand = try table.allocFrGrid(self.table.alloc, 2, MAX_CRAPS_BETS, &self.table.crypto.rng);
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
        try j.fieldU64s("plaintextBets", &flat);
        try j.fieldFrGrid("randomness", &rand_const);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(.craps_bet_main, json);
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        enc_bets: []const Ciphertext,
        bets: []const [2]u32,
        n_actual: u32,
        phase: u64,
        point: u64,
    ) !table.Proof {
        const idx = self.table.indexOfSelf(public_keys);
        var coeffs: [CRAPS_SHOWDOWN_TERMS]Fr = undefined;
        self.table.fillCoeffs(&coeffs);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, enc_bets, n_actual, phase, point);
        var dice: [2]u64 = undefined;
        try self.table.crypto.decryptCards(self.table.privateKey(), cards, partials, &dice);
        var flat: [24]u64 = undefined;
        @memset(&flat, 0);
        var i: usize = 0;
        while (i < MAX_CRAPS_BETS) : (i += 1) {
            const b = if (i < bets.len) bets[i] else [2]u32{ 0, 0 };
            flat[i * 2] = b[0];
            flat[i * 2 + 1] = b[1];
        }
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldCts("ciphertextBets", enc_bets);
        try j.fieldU64("nActualBets", n_actual);
        try j.fieldU64("phase", phase);
        try j.fieldU64("point", point);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", &dice);
        try j.fieldU64s("plaintextBets", &flat);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(.craps_showdown_hashout_main, json);
    }
};
