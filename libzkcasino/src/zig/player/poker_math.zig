//! Poker share / showdown math used by Zig players and the native app bridge.
//! Does not import the Groth16 prove stack.
const std = @import("std");
const poseidon = @import("../crypto/poseidon.zig");
const hash = @import("../crypto/hash.zig");
const elg = @import("../crypto/elgamal.zig");
const zk = @import("../crypto/zk_crypto.zig");
const hand = @import("hand_eval.zig");
const base = @import("player_base.zig");

pub const hash_mod = hash;
pub const zk_mod = zk;

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;
pub const Point = base.Point;
pub const Delta = zk.Delta;
pub const MAX_PLAYERS: usize = 10;
pub const TOTAL_CARDS: usize = 25;
pub const SHARE_OTHERS: usize = 9;

pub fn shareHash(
    crypto: *const Crypto,
    cts: []const Ciphertext,
    card_mask: u64,
    pk: PublicKey,
    others: []const PublicKey,
) Fr {
    var keys: [10]PublicKey = undefined;
    keys[0] = pk;
    @memcpy(keys[1..], others[0..9]);
    return poseidon.hash(&.{
        crypto.hashCiphertexts(cts),
        Fr.fromU64(card_mask),
        hash.hashPublicKeys10(&keys),
    });
}

pub fn share(
    crypto: *const Crypto,
    cts: []const Ciphertext,
    card_mask: u64,
    recipients: []const PublicKey,
    sk: Fr,
    randomness: []const []const Fr,
    out: [][]Ciphertext,
) void {
    _ = crypto;
    var p: usize = 0;
    while (p < recipients.len) : (p += 1) {
        var c: usize = 0;
        while (c < cts.len) : (c += 1) {
            const partial = elg.createPartial(sk, cts[c]);
            const masked = ((card_mask >> @intCast(c)) & 1) == 0;
            out[p][c] = elg.reencryptPartial(partial, recipients[p], randomness[p][c], masked);
        }
    }
}

pub fn showdownHash(
    crypto: *const Crypto,
    pot_masks: []const Fr,
    public_keys: []const PublicKey,
    player_index: Fr,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    seal_commitment: Fr,
) Fr {
    const h1 = poseidon.hash(pot_masks);
    var keys: [10]PublicKey = undefined;
    @memcpy(keys[0..public_keys.len], public_keys);
    var i = public_keys.len;
    while (i < 10) : (i += 1) keys[i] = PublicKey.identity();
    const h2 = hash.hashPublicKeys10(&keys);

    var h3_in: [10]Fr = undefined;
    h3_in[0] = crypto.hashCiphertexts(cards);
    var p: usize = 0;
    while (p < partials.len) : (p += 1) {
        h3_in[p + 1] = crypto.hashCiphertexts(partials[p]);
    }
    const h3 = poseidon.hash(h3_in[0 .. 1 + partials.len]);
    return poseidon.hash(&.{ h1, player_index, h2, h3, seal_commitment });
}

pub fn compareHands(pot_masks: []const u64, plaintext: []const u64, out: []u64) void {
    hand.winnerMasks(pot_masks, plaintext, out);
}

pub fn computeShowdownOutputHash(winner_masks: []const Fr, coefficients: []const Fr) Fr {
    std.debug.assert(winner_masks.len == 9);
    std.debug.assert(coefficients.len >= 2);
    var total = Fr.zero();
    var place = Fr.one();
    const scale = Fr.fromU64(1024);
    for (winner_masks) |mask| {
        total = total.add(mask.mul(place));
        place = place.mul(scale);
    }
    return total.add(Fr.one()).mul(coefficients[0]).add(coefficients[1]);
}

pub const STREET_COUNT: usize = 13;

fn streetCards(street: usize, out: *[3]u8) []const u8 {
    if (street < 10) {
        out[0] = @intCast(street * 2);
        out[1] = @intCast(street * 2 + 1);
        return out[0..2];
    }
    if (street == 10) {
        out[0] = 20;
        out[1] = 21;
        out[2] = 22;
        return out[0..3];
    }
    if (street == 11) {
        out[0] = 23;
        return out[0..1];
    }
    out[0] = 24;
    return out[0..1];
}

/// First-level Poseidon of one street's recipient-major partials.
/// `values` is the 9×25×4 share grid.
pub fn streetHashFromFlat(values: []const Fr, street: usize) Fr {
    std.debug.assert(values.len == SHARE_OTHERS * TOTAL_CARDS * 4);
    var cards: [3]u8 = undefined;
    const set = streetCards(street, &cards);
    var buf: [9 * 3 * 4]Fr = undefined;
    var n: usize = 0;
    var recipient: usize = 0;
    while (recipient < SHARE_OTHERS) : (recipient += 1) {
        for (set) |card| {
            const at = recipient * TOTAL_CARDS * 4 + @as(usize, card) * 4;
            buf[n..][0..4].* = values[at..][0..4].*;
            n += 4;
        }
    }
    return hash.hashFieldElements(buf[0..n]);
}

pub fn shareStreetHashes(values: []const Fr, out: *[STREET_COUNT]Fr) void {
    for (out, 0..) |*slot, street| slot.* = streetHashFromFlat(values, street);
}

/// Poseidon(10 hole hashes) and Poseidon(flop, turn, river), then Poseidon of those two.
/// Each call has at most 12 inputs, matching the on-chain hasher.
pub fn finalShareHash(streets: *const [STREET_COUNT]Fr) Fr {
    const holes = poseidon.hash(streets[0..10]);
    const board = poseidon.hash(streets[10..13]);
    return poseidon.hash(&.{ holes, board });
}

pub fn computeShareOutputHash(values: []const Fr, n_actual_players: u32) Fr {
    _ = n_actual_players;
    var streets: [STREET_COUNT]Fr = undefined;
    shareStreetHashes(values, &streets);
    return finalShareHash(&streets);
}

pub fn shareCardMask(n_players: u32) u64 {
    var mask: u64 = 0;
    var i: u32 = 0;
    while (i < n_players * 2) : (i += 1) mask |= @as(u64, 1) << @intCast(i);
    i = 20;
    while (i < 25) : (i += 1) mask |= @as(u64, 1) << @intCast(i);
    return mask;
}

pub fn derangement(crypto: *Crypto, out: []u16) void {
    crypto.derangement(out);
}

pub fn generateShufflePermutation(crypto: *Crypto, n: usize, out: []u8) void {
    crypto.generateShufflePermutation(n, out);
}

pub fn decryptWithSk(crypto: *const Crypto, sk: Fr, ct: Ciphertext) isize {
    return crypto.decryptWithSk(sk, ct);
}

pub fn decryptCard(crypto: *const Crypto, ct: Ciphertext, aggregated: Delta) isize {
    return crypto.decryptCard(ct, aggregated);
}

pub fn lookupCatalog(crypto: *const Crypto, m: Point) isize {
    return crypto.catalogIndex(m);
}

pub fn decryptOwnCards(crypto: *const Crypto, sk: Fr, cards: []const Ciphertext, out: []isize) void {
    std.debug.assert(out.len >= cards.len);
    for (cards, 0..) |ct, i| out[i] = crypto.decryptWithSk(sk, ct);
}

pub fn playerInPots(pot_masks: []const u64, player: usize) bool {
    for (pot_masks) |mask| {
        if ((mask >> @intCast(player)) & 1 == 1) return true;
    }
    return false;
}

pub fn decryptCards(
    crypto: *const Crypto,
    sk: Fr,
    pot_mask: u64,
    cards: []const Ciphertext,
    partials: []const []const Ciphertext,
    out: []u64,
) !void {
    var i: usize = 0;
    while (i < cards.len) : (i += 1) {
        const p = i / 2;
        if (p < MAX_PLAYERS and ((pot_mask >> @intCast(p)) & 1) == 0) {
            out[i] = 0;
            continue;
        }
        var received: [16]Ciphertext = undefined;
        var r: usize = 0;
        while (r < partials.len) : (r += 1) received[r] = partials[r][i];
        const idx = crypto.decryptFromPartials(sk, cards[i], received[0..partials.len]);
        if (idx < 0) return error.DecryptFailed;
        out[i] = @intCast(idx);
    }
}
