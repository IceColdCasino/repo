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
    return hash.shareInputHashHouse(crypto.hashCiphertexts(cts), hash.hashPublicKeysN(keys[0..n]));
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    player_card_count: u64,
    dealer_card_count: u64,
    seal_commitment: Fr,
) Fr {
    const h1 = hash.hashPublicKeysN(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    return poseidon.hash(&.{ Fr.fromU64(player_card_count), Fr.fromU64(dealer_card_count), h1, player_index, h2, seal_commitment });
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
    upcard: Ciphertext,
    upcard_partials: []const Ciphertext,
    insurance_eligible: bool,
    seal_commitment: Fr,
) Fr {
    const h1 = hash.hashPublicKeysN(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    const split = if (is_dealer) false else can_split;
    const h17 = if (is_dealer) hit_soft_17 else false;
    var up_in: [13]Fr = undefined;
    const up_one = [_]Ciphertext{upcard};
    up_in[0] = crypto.hashCiphertexts(&up_one);
    var u: usize = 0;
    while (u < upcard_partials.len) : (u += 1) {
        const part_one = [_]Ciphertext{upcard_partials[u]};
        up_in[u + 1] = crypto.hashCiphertexts(&part_one);
    }
    const upcard_hash = poseidon.hash(up_in[0 .. 1 + upcard_partials.len]);
    return poseidon.hash(&.{
        h1,
        h2,
        upcard_hash,
        Fr.fromU64(card_count),
        Fr.fromU64(if (split) 1 else 0),
        Fr.fromU64(if (h17) 1 else 0),
        Fr.fromU64(if (is_dealer) 1 else 0),
        Fr.fromU64(if (insurance_eligible) 1 else 0),
        seal_commitment,
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
pub const SHARE_OTHERS: usize = 7;

/// Poseidon of one card's recipient-major partials (7 seats × 4 limbs).
pub fn cardHashFromFlat(values: []const Fr, card: usize) Fr {
    std.debug.assert(values.len == SHARE_OTHERS * CHUNK_SHARE_CARDS * 4);
    std.debug.assert(card < CHUNK_SHARE_CARDS);
    var buf: [SHARE_OTHERS * 4]Fr = undefined;
    var n: usize = 0;
    var recipient: usize = 0;
    while (recipient < SHARE_OTHERS) : (recipient += 1) {
        const at = recipient * CHUNK_SHARE_CARDS * 4 + card * 4;
        buf[n..][0..4].* = values[at..][0..4].*;
        n += 4;
    }
    return hash.hashFieldElements(buf[0..n]);
}

pub fn shareCardHashes(values: []const Fr, out: *[CHUNK_SHARE_CARDS]Fr) void {
    for (out, 0..) |*slot, card| slot.* = cardHashFromFlat(values, card);
}

/// Poseidon(8) of cards 0..7 and Poseidon(8) of cards 8..15, then Poseidon of those two.
/// Each call has at most 12 inputs, matching the on-chain hasher.
pub fn finalShareHash(cards: *const [CHUNK_SHARE_CARDS]Fr) Fr {
    const first = poseidon.hash(cards[0..8]);
    const rest = poseidon.hash(cards[8..16]);
    return poseidon.hash(&.{ first, rest });
}

pub fn computeShareOutputHash(values: []const Fr, n_actual: u32) Fr {
    _ = n_actual;
    var cards: [CHUNK_SHARE_CARDS]Fr = undefined;
    shareCardHashes(values, &cards);
    return finalShareHash(&cards);
}

pub fn hashCardColumn(values: []const Fr) Fr {
    std.debug.assert(values.len == SHARE_OTHERS * 4);
    return hash.hashFieldElements(values);
}

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
        return self.table.linearShareProveHouse(.blackjack_share_hashout_main, chunk, keys, n_actual, h);
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
        upcard: Ciphertext,
        upcard_partials: []const Ciphertext,
        upcard_plain: u64,
        insurance_eligible: bool,
    ) !table.Proof {
        const commitment = self.table.sealCommitment();
        const h = actionHash(self.table.crypto, public_keys, cards, partials, card_count, can_split, hit_soft_17, is_dealer, upcard, upcard_partials, insurance_eligible, commitment);
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldFr("sealCommitment", commitment);
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
        try j.fieldCt("upcardCiphertext", upcard);
        try j.fieldCts("upcardPartials", upcard_partials);
        try j.fieldU64("insuranceEligible", if (insurance_eligible) 1 else 0);
        try j.fieldU64("upcardPlaintext", upcard_plain);
        try j.fieldFrs("coefficients", self.table.sealedSlots()[0..2]);
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
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, player_n, dealer_n, self.table.sealCommitment());
        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try self.table.writeSealedShowdown(&j, h, 2);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldU64("playerCardCount", player_n);
        try j.fieldU64("dealerCardCount", dealer_n);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", plaintext);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        return self.table.proveJson(.blackjack_showdown_hashout_main, json);
    }
};
