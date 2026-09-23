const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const base = @import("player_base.zig");
const eval = @import("blackjack_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;

pub fn hashPublicKeys(keys: []const PublicKey) Fr {
    return hash.hashPublicKeysN(keys);
}

pub fn shareHash(crypto: *const Crypto, cts: []const Ciphertext, pk: PublicKey, others: []const PublicKey) Fr {
    var keys: [12]PublicKey = undefined;
    keys[0] = pk;
    @memcpy(keys[1 .. 1 + others.len], others);
    const n = 1 + others.len;
    return poseidon.hash(&.{ crypto.hashCiphertexts(cts), hash.hashPublicKeysN(keys[0..n]) });
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    player_card_count: u64,
    dealer_card_count: u64,
) Fr {
    const h1 = hash.hashPublicKeysN(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    return poseidon.hash(&.{ Fr.fromU64(player_card_count), Fr.fromU64(dealer_card_count), h1, player_index, h2 });
}

pub fn actionHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    card_count: u64,
    can_split: bool,
    hit_soft_17: bool,
    is_dealer: bool,
) Fr {
    const h1 = hash.hashPublicKeysN(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    const split = if (is_dealer) false else can_split;
    const h17 = if (is_dealer) hit_soft_17 else false;
    return poseidon.hash(&.{
        h1,
        h2,
        Fr.fromU64(card_count),
        Fr.fromU64(if (split) 1 else 0),
        Fr.fromU64(if (h17) 1 else 0),
        Fr.fromU64(if (is_dealer) 1 else 0),
    });
}

pub fn hashPermutationMatrixSixDeck(crypto: *const Crypto, matrix: []const u8) Fr {
    var rows: [312]Fr = undefined;
    var i: usize = 0;
    while (i < 312) : (i += 1) {
        rows[i] = hash.bits2num(matrix[i * 312 .. (i + 1) * 312]);
    }
    var deck_hashes: [6]Fr = undefined;
    var d: usize = 0;
    while (d < 6) : (d += 1) {
        deck_hashes[d] = hash.hashRowValues(rows[d * 52 .. (d + 1) * 52]);
    }
    _ = crypto;
    return poseidon.hash(&deck_hashes);
}

pub const computeHandValue = eval.computeHandValue;
pub const compareToDealer = eval.compareToDealer;
pub const actionStatus = eval.actionStatus;
pub const dealerActionStatus = eval.dealerActionStatus;
pub const CHUNK_SHARE_CARDS: usize = 16;

pub const Player = struct {
    table: table.TablePlayer,
    shuffle_id: prove.CircuitId = .shuffle_6_deck_52_main,

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
        return self.table.shuffleProve(self.shuffle_id, deck, keys);
    }

    pub fn shareProveChunk(self: *Player, chunk: []const Ciphertext, keys: []const PublicKey, n_actual: u32) !table.ShareOut {
        const h = shareHash(self.table.crypto, chunk, self.table.publicKey(), keys);
        return self.table.linearShareProve(.blackjack_share_hashout_main, chunk, keys, n_actual, h);
    }

    pub fn actionProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        plaintext: []const u64,
        card_count: u64,
        can_split: bool,
        hit_soft_17: bool,
        is_dealer: bool,
    ) !table.Proof {
        const h = actionHash(self.table.crypto, public_keys, cards, partials, card_count, can_split, hit_soft_17, is_dealer);
        var coeffs: [2]Fr = undefined;
        self.table.fillActionCoeffs(&coeffs);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", plaintext);
        try j.fieldU64("cardCount", card_count);
        try j.fieldU64("canSplit", if (can_split) 1 else 0);
        try j.fieldU64("hitSoft17", if (hit_soft_17) 1 else 0);
        try j.fieldU64("isDealer", if (is_dealer) 1 else 0);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(.blackjack_action_hashout_main, json);
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        plaintext: []const u64,
        player_n: u64,
        dealer_n: u64,
    ) !table.Proof {
        const idx = self.table.indexOfSelf(public_keys);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, player_n, dealer_n);
        var coeffs: [1]Fr = undefined;
        self.table.fillCoeffs(&coeffs);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldU64("playerCardCount", player_n);
        try j.fieldU64("dealerCardCount", dealer_n);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", plaintext);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(.blackjack_showdown_hashout_main, json);
    }
};
