const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const baby = @import("../crypto/babyjub.zig");
const poly = @import("../crypto/poly_hash.zig");
const base = @import("player_base.zig");
const eval = @import("slot_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;

pub fn shareHash(crypto: *const Crypto, cts: []const Ciphertext, pk: PublicKey, others: []const PublicKey) Fr {
    return poseidon.hash(&.{
        crypto.hashCiphertexts(cts),
        hash.hashPublicKeys2(&.{ pk, others[0] }),
    });
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    bet: Ciphertext,
) Fr {
    const h1 = hash.hashPublicKeys2(public_keys);
    var h2_in: [4]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    return poseidon.hash(&.{ h1, player_index, h2, crypto.hashCiphertexts(&.{bet}) });
}

pub fn encryptCoinBet(crypto: *const Crypto, coin_bet: u64, pk: PublicKey, r: Fr) Ciphertext {
    const pt = baby.mulBase8Limbs(.{ coin_bet, 0, 0, 0 });
    return crypto.encrypt(pt, pk, r);
}

pub fn commitCoinBet(crypto: *const Crypto, coin_bet: u64, pks: []const PublicKey, randomness: []const Fr, out: []Ciphertext) void {
    for (pks, 0..) |pk, i| out[i] = encryptCoinBet(crypto, coin_bet, pk, randomness[i]);
}

pub fn hashIndependentPermutations(matrices: []const []const u8, stop_count: usize) Fr {
    var hashes: [5]Fr = undefined;
    for (matrices, 0..) |m, i| {
        hashes[i] = hash.hashPermutationMatrix(m, stop_count);
    }
    return poseidon.hash(hashes[0..matrices.len]);
}

fn hashIndependentPermutationsMats(matrix: []const u8, n_reels: usize, n_stops: usize) Fr {
    var hashes: [5]Fr = undefined;
    var i: usize = 0;
    while (i < n_reels) : (i += 1) {
        const start = i * n_stops * n_stops;
        hashes[i] = hash.hashPermutationMatrix(matrix[start .. start + n_stops * n_stops], n_stops);
    }
    return poseidon.hash(hashes[0..n_reels]);
}

pub const evaluateThreeReelStops = eval.evaluateThreeReelStops;
pub const evaluateFiveReelStops = eval.evaluateFiveReelStops;

pub fn computeShareOutputHash(values: []const Fr, n_reels: u32, n_actual: u32) Fr {
    if (n_reels == 3) return poly.hashRecipientMajor(values, 1, 3, 2, n_actual);
    return poly.hashRecipientMajor(values, 1, 5, 2, n_actual);
}

pub const Player = struct {
    table: table.TablePlayer,
    n_reels: u32 = 3,

    pub fn init(alloc: std.mem.Allocator, engine: *table.Engine, crypto: *Crypto, n_reels: u32) Player {
        return .{ .table = .init(alloc, engine, crypto), .n_reels = n_reels };
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

    pub fn shuffleProve(self: *Player, reels: []const []const Ciphertext, keys: []const PublicKey) !table.ShuffleOut {
        const n_reels: usize = self.n_reels;
        const n_stops: usize = 22;
        if (reels.len != n_reels) return error.InvalidReels;
        var flat_in: [5 * 22]Ciphertext = undefined;
        var n: usize = 0;
        for (reels) |reel| {
            if (reel.len != n_stops) return error.InvalidReelStops;
            @memcpy(flat_in[n .. n + reel.len], reel);
            n += reel.len;
        }
        const h = poseidon.hash(&.{
            self.table.crypto.hashCiphertexts(flat_in[0..n]),
            hash.hashPublicKeys2(keys),
        });

        const matrix = try self.table.alloc.alloc(u8, n_reels * n_stops * n_stops);
        defer self.table.alloc.free(matrix);
        const randomness = try self.table.alloc.alloc(Fr, n_reels * n_stops);
        defer self.table.alloc.free(randomness);
        const shuffled = try self.table.alloc.alloc(Ciphertext, n);
        errdefer self.table.alloc.free(shuffled);

        var r: usize = 0;
        while (r < n_reels) : (r += 1) {
            const m = matrix[r * n_stops * n_stops .. (r + 1) * n_stops * n_stops];
            const rand = randomness[r * n_stops .. (r + 1) * n_stops];
            self.table.crypto.generateShufflePermutation(n_stops, m);
            self.table.crypto.generateShuffleRandomness(n_stops, rand);
            _ = self.table.crypto.shuffle(
                reels[r],
                keys,
                m,
                rand,
                shuffled[r * n_stops .. (r + 1) * n_stops],
                n_stops,
            );
        }

        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldCts("reels", flat_in[0..n]);
        try j.fieldPoints("publicKeys", keys);
        try j.fieldBytes("permutationMatrix", matrix);
        try j.fieldFrs("randomness", randomness);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const id: prove.CircuitId = if (self.n_reels == 5) .shuffle_5_reel_22_main else .shuffle_3_reel_22_main;
        const proof = try self.table.proveJson(id, json);
        return .{
            .proof = proof,
            .deck = shuffled,
            .permutation_hash = hashIndependentPermutationsMats(matrix, n_reels, n_stops),
            .alloc = self.table.alloc,
        };
    }

    pub fn shareProve(self: *Player, centers: []const Ciphertext, keys: []const PublicKey, coin_bet: u64) !table.ShareOut {
        const h = shareHash(self.table.crypto, centers, self.table.publicKey(), keys);
        const card_rand = try table.allocFrGrid(self.table.alloc, keys.len, self.n_reels, &self.table.crypto.rng);
        defer self.table.alloc.free(card_rand.rows);
        defer self.table.alloc.free(card_rand.flat);
        var bet_rand: [2]Fr = .{ self.table.crypto.rng.scalar253(), self.table.crypto.rng.scalar253() };
        const out_grid = try table.allocGrid(self.table.alloc, keys.len, centers.len);
        var rand_const: [4][]const Fr = undefined;
        var i: usize = 0;
        while (i < keys.len) : (i += 1) rand_const[i] = card_rand.rows[i];
        self.table.crypto.share(centers, keys, self.table.privateKey(), rand_const[0..keys.len], out_grid.rows);

        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldCts("ciphertext", centers);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldPoints("publicKeys", keys);
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldFrGrid("cardRandomness", rand_const[0..keys.len]);
        try j.fieldU64("nActualPlayers", 2);
        try j.fieldU64("coinBet", coin_bet);
        try j.fieldFrs("betRandomness", &bet_rand);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const id: prove.CircuitId = if (self.n_reels == 5) .slot_share_5_reel_hashout_main else .slot_share_3_reel_hashout_main;
        const proof = try self.table.proveJson(id, json);
        return .{ .proof = proof, .rows = out_grid.rows, .flat = out_grid.flat, .alloc = self.table.alloc };
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        enc_bet: Ciphertext,
        coin_bet: u64,
    ) !table.Proof {
        const idx = self.table.indexOfSelf(public_keys);
        var coeffs: [1]Fr = undefined;
        self.table.fillCoeffs(&coeffs);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, enc_bet);
        var centers: [5]u64 = undefined;
        try self.table.crypto.decryptCards(self.table.privateKey(), cards, partials, centers[0..cards.len]);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldCt("ciphertextBet", enc_bet);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", centers[0..cards.len]);
        try j.fieldU64("coinBet", coin_bet);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(if (self.n_reels == 5) .slot_showdown_5_reel_hashout_main else .slot_showdown_3_reel_hashout_main, json);
    }
};
