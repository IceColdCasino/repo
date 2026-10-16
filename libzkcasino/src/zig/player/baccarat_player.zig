const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const base = @import("player_base.zig");
const eval = @import("baccarat_eval.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;

pub fn shareHash(crypto: *const Crypto, cts: []const Ciphertext, pk: PublicKey, others: []const PublicKey) Fr {
    var keys: [12]PublicKey = undefined;
    keys[0] = pk;
    @memcpy(keys[1 .. 1 + others.len], others);
    return hash.shareInputHashHouse(crypto.hashCiphertexts(cts), hash.hashPublicKeysN(keys[0 .. 1 + others.len]));
}

pub fn showdownHash(
    crypto: *const Crypto,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    seal_commitment: Fr,
) Fr {
    const h1 = hash.hashPublicKeysN(public_keys);
    var h2_in: [13]Fr = undefined;
    h2_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) h2_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    const h2 = poseidon.hash(h2_in[0 .. 1 + partials.len]);
    return poseidon.hash(&.{ h1, player_index, h2, seal_commitment });
}

pub const evaluate = eval.evaluate;

pub const TOTAL_CARDS: usize = 6;
pub const SHARE_OTHERS: usize = 11;
pub const STREET_COUNT: usize = 4;

fn streetCards(street: usize) []const usize {
    return switch (street) {
        0 => &.{ 0, 1 },
        1 => &.{ 2, 3 },
        2 => &.{4},
        3 => &.{5},
        else => unreachable,
    };
}

/// Poseidon of one street's recipient-major partials.
pub fn streetHashFromFlat(values: []const Fr, street: usize) Fr {
    std.debug.assert(values.len == SHARE_OTHERS * TOTAL_CARDS * 4);
    const cards = streetCards(street);
    var buf: [SHARE_OTHERS * 2 * 4]Fr = undefined;
    var n: usize = 0;
    var recipient: usize = 0;
    while (recipient < SHARE_OTHERS) : (recipient += 1) {
        for (cards) |card| {
            const at = recipient * TOTAL_CARDS * 4 + card * 4;
            buf[n..][0..4].* = values[at..][0..4].*;
            n += 4;
        }
    }
    return hash.hashFieldElements(buf[0..n]);
}

pub fn shareStreetHashes(values: []const Fr, out: *[STREET_COUNT]Fr) void {
    for (out, 0..) |*slot, street| slot.* = streetHashFromFlat(values, street);
}

/// Poseidon of the four street hashes. Four inputs fit in one on-chain call.
pub fn finalShareHash(streets: *const [STREET_COUNT]Fr) Fr {
    return poseidon.hash(streets);
}

pub fn computeShareOutputHash(values: []const Fr, n_actual: u32) Fr {
    _ = n_actual;
    var streets: [STREET_COUNT]Fr = undefined;
    shareStreetHashes(values, &streets);
    return finalShareHash(&streets);
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

    pub fn shareProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey, n_actual: u32) !table.ShareOut {
        const h = shareHash(self.table.crypto, deck, self.table.publicKey(), keys);
        return self.table.linearShareProveHouse(.baccarat_share_hashout_main, deck, keys, n_actual, h);
    }

    pub fn showdownProve(
        self: *Player,
        public_keys: []const PublicKey,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
    ) !struct { proof: table.Proof, winner: u64, plaintext: [6]u64 } {
        const idx = self.table.indexOfSelf(public_keys);
        const h = showdownHash(self.table.crypto, public_keys, Fr.fromU64(idx), cards, partials, self.table.sealCommitment());
        var plaintext: [6]u64 = undefined;
        try self.table.crypto.decryptCards(self.table.privateKey(), cards, partials, &plaintext);
        var faces: [6]u32 = undefined;
        for (plaintext, 0..) |p, i| faces[i] = @intCast(p);
        const winner = evaluate(&faces);

        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try self.table.writeSealedShowdown(&j, h, 2);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldU64("playerIndex", idx);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", &plaintext);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const proof = try self.table.proveJson(.baccarat_showdown_hashout_main, json);
        return .{ .proof = proof, .winner = winner, .plaintext = plaintext };
    }
};
