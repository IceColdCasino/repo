//! Showdown coefficient seal (matches `showdown_seal.circom` and Arcis
//! `seal_showdown_coefficients`). Arcis draws two coefficients of 128 bits with
//! bit 127 set and reveals four subset sums of their bits under
//! `seal_weights.zig`. The account still stores 14 ciphertext slots. Each sum
//! is below 2^253, so it is the same integer in BN254. The showdown input hash
//! Poseidon-binds those sums with the other fields.
const std = @import("std");
const Fr = @import("fr.zig").Fr;
const poseidon = @import("poseidon.zig");
const weights = @import("seal_weights.zig");

pub const SLOTS = 14;
pub const LIVE = 2;
pub const BITS = 128;
pub const ROWS = weights.ROWS;

comptime {
    std.debug.assert(LIVE * BITS == weights.WIDTH);
}

/// A sealed coefficient is below 2^128 with bit 127 set.
pub fn isSlot(c: Fr) bool {
    const limbs = c.toNormal();
    return limbs[2] == 0 and limbs[3] == 0 and (limbs[1] >> 63) == 1;
}

pub fn validate(coeffs: []const Fr) error{InvalidSealedCoefficient}!void {
    if (coeffs.len != SLOTS) return error.InvalidSealedCoefficient;
    for (coeffs) |c| {
        if (!isSlot(c)) return error.InvalidSealedCoefficient;
    }
}

/// rows[k] = Σ weight[k][i * 128 + j] over the set bits j of the two live coefficients.
pub fn rows(coeffs: *const [SLOTS]Fr) [ROWS]Fr {
    var out = [_]Fr{Fr.zero()} ** ROWS;
    for (coeffs[0..LIVE], 0..) |c, i| {
        const limbs = c.toNormal();
        for (0..BITS) |j| {
            if ((limbs[j / 64] >> @as(u6, @intCast(j % 64))) & 1 == 0) continue;
            for (0..ROWS) |k| {
                out[k] = out[k].add(Fr.fromNormal(weights.SEAL_WEIGHTS[k][i * BITS + j]));
            }
        }
    }
    return out;
}

/// Poseidon of the four rows. The showdown input hash uses this as its last field.
pub fn rowsCommitment(r: *const [ROWS]Fr) Fr {
    return poseidon.hash(r);
}

/// Commitment of the rows these coefficients produce.
pub fn commitment(coeffs: *const [SLOTS]Fr) Fr {
    const r = rows(coeffs);
    return rowsCommitment(&r);
}

/// `SealedShowdownCoefficients` layout: discriminator, game_id, player_index,
/// n_active, 14 ciphertexts, encryption pubkey, nonce (u128 LE), 4 rows (BE),
/// then 32 unused bytes that keep the following fields aligned.
pub const ACCOUNT_LEN = 8 + 32 + 1 + 1 + SLOTS * 32 + 32 + 16 + ROWS * 32 + 32;

pub const Account = struct {
    game_id: [32]u8,
    player_index: u8,
    n_active: u8,
    ciphertexts: [SLOTS][32]u8,
    encryption_pubkey: [32]u8,
    nonce: u128,
    rows: [ROWS]Fr,
    /// Poseidon of `rows`. Showdown's input hash uses this value.
    commitment: Fr,
    /// The seal callback has written the ciphertexts and the four rows.
    written: bool,
};

pub fn parseAccount(data: []const u8) error{ SealAccountTooShort, SealRowOutOfRange }!Account {
    if (data.len < ACCOUNT_LEN) return error.SealAccountTooShort;
    var out: Account = undefined;
    var at: usize = 8;
    @memcpy(&out.game_id, data[at..][0..32]);
    at += 32;
    out.player_index = data[at];
    out.n_active = data[at + 1];
    at += 2;
    var any_ciphertext = false;
    for (&out.ciphertexts) |*ct| {
        @memcpy(ct, data[at..][0..32]);
        at += 32;
        any_ciphertext = any_ciphertext or !std.mem.allEqual(u8, ct, 0);
    }
    @memcpy(&out.encryption_pubkey, data[at..][0..32]);
    at += 32;
    out.nonce = std.mem.readInt(u128, data[at..][0..16], .little);
    at += 16;
    var any_row = false;
    for (&out.rows) |*row| {
        row.* = try rowFromBe(data[at..][0..32]);
        at += 32;
        any_row = any_row or !row.isZero();
    }
    out.commitment = if (any_row) rowsCommitment(&out.rows) else Fr.zero();
    out.written = any_ciphertext and any_row;
    return out;
}

/// A row as Light reads it: a big-endian integer below 2^253.
fn rowFromBe(bytes: *const [32]u8) error{SealRowOutOfRange}!Fr {
    if (bytes[0] >> 5 != 0) return error.SealRowOutOfRange;
    return frFromBe(bytes);
}

/// Big-endian BN254 integer.
fn frFromBe(bytes: *const [32]u8) Fr {
    var limbs: [4]u64 = undefined;
    for (0..4) |i| {
        limbs[i] = std.mem.readInt(u64, bytes[32 - 8 * (i + 1) ..][0..8], .big);
    }
    return Fr.fromNormal(limbs);
}

/// Showdown Groth16 public `hash`: Poseidon(statement hash, seal commitment).
pub fn publicHash(input_hash: Fr, seal_commitment: Fr) Fr {
    return poseidon.hash(&.{ input_hash, seal_commitment });
}
