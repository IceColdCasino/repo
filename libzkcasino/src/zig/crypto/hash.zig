const Fr = @import("fr.zig").Fr;
const poseidon = @import("poseidon.zig");
const elg = @import("elgamal.zig");

pub const POSEIDON_CHUNK = 12;
pub const SHUFFLE_PLAYER_SLOTS = 12;
pub const SHARE_PLAYER_SLOTS = 10;

pub fn hashFlat(values: []const Fr) Fr {
    if (values.len == 0) @panic("hashFlat requires values");
    const n_chunks = (values.len + POSEIDON_CHUNK - 1) / POSEIDON_CHUNK;
    // 8×52 shoe = 416 cts × 4 limbs = 1664 Fr → 139 Poseidon-12 chunks.
    var chunk_hashes_buf: [160]Fr = undefined;
    if (n_chunks > chunk_hashes_buf.len) @panic("hashFlat too large");
    var c: usize = 0;
    while (c < n_chunks) : (c += 1) {
        const start = c * POSEIDON_CHUNK;
        const end = @min(start + POSEIDON_CHUNK, values.len);
        chunk_hashes_buf[c] = poseidon.hash(values[start..end]);
    }
    return combine(chunk_hashes_buf[0..n_chunks]);
}

fn combine(hashes: []const Fr) Fr {
    if (hashes.len == 1) return hashes[0];
    if (hashes.len <= POSEIDON_CHUNK) return poseidon.hash(hashes);
    const n2 = (hashes.len + POSEIDON_CHUNK - 1) / POSEIDON_CHUNK;
    var level: [32]Fr = undefined;
    if (n2 > level.len) @panic("hashFlat combine too large");
    var c: usize = 0;
    while (c < n2) : (c += 1) {
        const start = c * POSEIDON_CHUNK;
        const end = @min(start + POSEIDON_CHUNK, hashes.len);
        level[c] = poseidon.hash(hashes[start..end]);
    }
    return combine(level[0..n2]);
}

pub fn hashRowValues(row_values: []const Fr) Fr {
    return hashFlat(row_values);
}

pub fn hashPublicKeysN(keys: []const elg.PublicKey) Fr {
    const n = keys.len;
    std_assert(n >= 2 and n <= 12 and n % 2 == 0);
    var flat: [24]Fr = undefined;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        flat[i * 2] = keys[i].x;
        flat[i * 2 + 1] = keys[i].y;
    }
    const split = n / 2;
    const h1 = poseidon.hash(flat[0 .. split * 2]);
    const h2 = poseidon.hash(flat[split * 2 .. n * 2]);
    return poseidon.hash(&.{ h1, h2 });
}

pub fn hashPublicKeys12(keys: []const elg.PublicKey) Fr {
    std_assert(keys.len == 12);
    return hashPublicKeysN(keys);
}

pub fn hashPublicKeys10(keys: []const elg.PublicKey) Fr {
    std_assert(keys.len == 10);
    return hashPublicKeysN(keys);
}

pub fn hashPublicKeys2(keys: []const elg.PublicKey) Fr {
    std_assert(keys.len == 2);
    return hashPublicKeysN(keys);
}

/// Circom `HashFlat` / `HashCiphertexts`: chunk by 12, then fold.
/// A single chunk is wrapped in Poseidon(1).
pub fn hashFieldElements(values: []const Fr) Fr {
    if (values.len == 0) @panic("hashFieldElements requires values");
    const n_chunks = (values.len + POSEIDON_CHUNK - 1) / POSEIDON_CHUNK;
    const h = hashFlat(values);
    if (n_chunks == 1) return poseidon.hash(&.{h});
    return h;
}

/// Poseidon(ciphertext hash, public-key hash).
pub fn shareInputHashHouse(ct_hash: Fr, pk_hash: Fr) Fr {
    return poseidon.hash(&.{ ct_hash, pk_hash });
}

/// ShareHashOut: Poseidon of one HashCiphertexts per recipient row, including padded seats.
pub fn hashRecipientCiphertexts(values: []const Fr, n_others: usize, n_cards: usize) Fr {
    const stride = n_cards * 4;
    if (n_others == 0 or values.len != n_others * stride) @panic("hashRecipientCiphertexts size");
    var hashes: [16]Fr = undefined;
    if (n_others > hashes.len) @panic("hashRecipientCiphertexts too many recipients");
    var i: usize = 0;
    while (i < n_others) : (i += 1) {
        hashes[i] = hashFieldElements(values[i * stride .. (i + 1) * stride]);
    }
    return poseidon.hash(hashes[0..n_others]);
}

pub fn hashCiphertexts(cts: []const elg.Ciphertext) Fr {
    var buf: [2048]Fr = undefined;
    var n: usize = 0;
    for (cts) |ct| {
        const lim = ct.limbs();
        inline for (0..4) |k| {
            buf[n] = lim[k];
            n += 1;
        }
    }
    return hashFieldElements(buf[0..n]);
}

pub fn bits2num(bits: []const u8) Fr {
    var acc = Fr.zero();
    const two = Fr.fromU64(2);
    for (bits) |b| {
        acc = acc.mul(two).add(Fr.fromU64(b));
    }
    return acc;
}

pub fn hashPermutationMatrix(matrix: []const u8, matrix_size: usize) Fr {
    var rows: [416]Fr = undefined;
    var i: usize = 0;
    while (i < matrix_size) : (i += 1) {
        rows[i] = bits2num(matrix[i * matrix_size .. (i + 1) * matrix_size]);
    }
    return hashRowValues(rows[0..matrix_size]);
}

pub fn padShuffleKeys(keys: []const elg.PublicKey, out: *[12]elg.PublicKey) []elg.PublicKey {
    std_assert(keys.len <= 12);
    @memcpy(out[0..keys.len], keys);
    var i = keys.len;
    while (i < 12) : (i += 1) {
        out[i] = elg.PublicKey.identity();
    }
    return out[0..12];
}

pub fn padShareKeys(keys: []const elg.PublicKey, out: *[10]elg.PublicKey) []elg.PublicKey {
    std_assert(keys.len <= 10);
    @memcpy(out[0..keys.len], keys);
    var i = keys.len;
    while (i < 10) : (i += 1) {
        out[i] = elg.PublicKey.identity();
    }
    return out[0..10];
}

fn std_assert(ok: bool) void {
    if (!ok) @panic("hash assertion failed");
}
