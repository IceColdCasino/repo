const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const baby = @import("../crypto/babyjub.zig");
const base = @import("player_base.zig");
const eval = @import("roulette_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;

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

pub fn encryptBet(crypto: *const Crypto, typ: u32, modifier: u32, pk: PublicKey, r: Fr) Ciphertext {
    const packed_bet = eval.packBet(typ, modifier);
    const pt = baby.mulBase8Limbs(.{ packed_bet + 1, 0, 0, 0 });
    return crypto.encrypt(pt, pk, r);
}

pub const evaluateBet = eval.evaluateBet;
pub const MAX_BETS: usize = 12;

pub const Player = struct {
    table: table.TablePlayer,
    eu: bool = true,

    pub fn init(alloc: std.mem.Allocator, engine: *table.Engine, crypto: *Crypto, eu: bool) Player {
        return .{ .table = .init(alloc, engine, crypto), .eu = eu };
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
        return self.table.shuffleProve(if (self.eu) .shuffle_1_deck_37_main else .shuffle_1_deck_38_main, deck, keys);
    }

    pub fn shareProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey, n_actual: u32) !table.ShareOut {
        const h = shareHash(self.table.crypto, deck, self.table.publicKey(), keys);
        return self.table.linearShareProve(.roulette_share_hashout_main, deck, keys, n_actual, h);
    }

    pub fn betProve(self: *Player, house: PublicKey, bets: []const [2]u32) !table.Proof {
        const n_actual: u32 = @intCast(bets.len);
        const h = betHash(self.table.publicKey(), house, n_actual);
        var flat: [24]u64 = undefined;
        @memset(&flat, 0);
        var i: usize = 0;
        while (i < MAX_BETS) : (i += 1) {
            const b = if (i < bets.len) bets[i] else [2]u32{ 0, 0 };
            flat[i * 2] = b[0];
            flat[i * 2 + 1] = b[1];
        }
        const rand = try table.allocFrGrid(self.table.alloc, 2, MAX_BETS, &self.table.crypto.rng);
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
        return self.table.proveJson(if (self.eu) .roulette_bet_37_main else .roulette_bet_38_main, json);
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        enc_bets: []const Ciphertext,
        bets: []const [2]u32,
        n_actual: u32,
    ) !table.Proof {
        const idx = self.table.indexOfSelf(public_keys);
        var coeffs: [MAX_BETS]Fr = undefined;
        self.table.fillCoeffs(&coeffs);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, enc_bets, n_actual);
        var winner: [1]u64 = undefined;
        try self.table.crypto.decryptCards(self.table.privateKey(), cards, partials, &winner);
        var flat: [24]u64 = undefined;
        @memset(&flat, 0);
        var i: usize = 0;
        while (i < MAX_BETS) : (i += 1) {
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
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64("plaintextCard", winner[0]);
        try j.fieldU64s("plaintextBets", &flat);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(if (self.eu) .roulette_showdown_37_hashout_main else .roulette_showdown_38_hashout_main, json);
    }
};
