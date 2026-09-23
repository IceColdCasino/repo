//! C ABI for TypeScript player math. Field ops go through rapidsnark libfr.
const std = @import("std");
const Fr = @import("crypto/fr.zig").Fr;
const poseidon = @import("crypto/poseidon.zig");
const baby = @import("crypto/babyjub.zig");
const elg = @import("crypto/elgamal.zig");
const zk = @import("crypto/zk_crypto.zig");

const CATALOG_SIZE: usize = 52;

const Handle = struct {
    crypto: zk.Crypto,
};

fn readFr(src: [*]const u64) Fr {
    return Fr.fromNormal(.{ src[0], src[1], src[2], src[3] });
}

fn writeFr(dst: [*]u64, v: Fr) void {
    const n = v.toNormal();
    dst[0] = n[0];
    dst[1] = n[1];
    dst[2] = n[2];
    dst[3] = n[3];
}

fn readPoint(src: [*]const u64) baby.Point {
    return .{ .x = readFr(src), .y = readFr(src + 4) };
}

fn writePoint(dst: [*]u64, p: baby.Point) void {
    writeFr(dst, p.x);
    writeFr(dst + 4, p.y);
}

fn readCt(src: [*]const u64) elg.Ciphertext {
    return .{
        .c0x = readFr(src),
        .c0y = readFr(src + 4),
        .c1x = readFr(src + 8),
        .c1y = readFr(src + 12),
    };
}

export fn zkplayer_create(seed: u64) callconv(.c) ?*Handle {
    const alloc = std.heap.page_allocator;
    const h = alloc.create(Handle) catch return null;
    h.* = .{ .crypto = zk.Crypto.init(alloc, CATALOG_SIZE, seed) catch {
        alloc.destroy(h);
        return null;
    } };
    return h;
}

export fn zkplayer_free(handle: ?*Handle) callconv(.c) void {
    if (handle) |h| {
        h.crypto.deinit(std.heap.page_allocator);
        std.heap.page_allocator.destroy(h);
    }
}

export fn zkplayer_base8(out: [*]u64) callconv(.c) void {
    writePoint(out, baby.base8());
}

export fn zkplayer_generator(out: [*]u64) callconv(.c) void {
    writePoint(out, baby.generator());
}

export fn zkplayer_sub_order(out: [*]u64) callconv(.c) void {
    writeFr(out, baby.subOrder());
}

export fn zkplayer_poseidon(inputs: [*]const u64, n: u32, out: [*]u64) callconv(.c) i32 {
    if (n < 1 or n > 16) return -1;
    var buf: [16]Fr = undefined;
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        buf[i] = readFr(inputs + i * 4);
    }
    writeFr(out, poseidon.hash(buf[0..n]));
    return 0;
}

export fn zkplayer_add_point(a: [*]const u64, b: [*]const u64, out: [*]u64) callconv(.c) i32 {
    writePoint(out, baby.add(readPoint(a), readPoint(b)));
    return 0;
}

export fn zkplayer_mul_point(p: [*]const u64, k: [*]const u64, out: [*]u64) callconv(.c) i32 {
    writePoint(out, baby.mul(readPoint(p), readFr(k)));
    return 0;
}

export fn zkplayer_mul_base8(k: [*]const u64, out: [*]u64) callconv(.c) i32 {
    writePoint(out, baby.mulBase8(readFr(k)));
    return 0;
}

export fn zkplayer_neg(a: [*]const u64, out: [*]u64) callconv(.c) i32 {
    writeFr(out, readFr(a).neg());
    return 0;
}

export fn zkplayer_random(handle: ?*Handle, out: [*]u64) callconv(.c) i32 {
    const h = handle orelse return -1;
    writeFr(out, h.crypto.rng.field());
    return 0;
}

export fn zkplayer_in_curve(p: [*]const u64) callconv(.c) i32 {
    return if (baby.inCurve(readPoint(p))) 1 else 0;
}

/// `m = c1 - sk·c0`, then search the pre-generated `Base8*(i+1)` catalog.
export fn zkplayer_decrypt(handle: ?*Handle, sk: [*]const u64, ct: [*]const u64, out: *i32) callconv(.c) i32 {
    const h = handle orelse return -1;
    out.* = @intCast(h.crypto.decryptWithSk(readFr(sk), readCt(ct)));
    return 0;
}

/// `m = c1 - aggregated`, then catalog search (TypeScript `decryptCard`).
export fn zkplayer_decrypt_card(handle: ?*Handle, ct: [*]const u64, delta: [*]const u64, out: *i32) callconv(.c) i32 {
    const h = handle orelse return -1;
    out.* = @intCast(h.crypto.decryptCard(readCt(ct), readPoint(delta)));
    return 0;
}

/// Catalog lookup of an already-recovered BabyJub point.
export fn zkplayer_catalog_lookup(handle: ?*Handle, point: [*]const u64, out: *i32) callconv(.c) i32 {
    const h = handle orelse return -1;
    out.* = @intCast(h.crypto.catalogIndex(readPoint(point)));
    return 0;
}

/// Threshold decrypt: own `sk` plus re-encrypted partials, then catalog search.
export fn zkplayer_decrypt_from_partials(
    handle: ?*Handle,
    sk: [*]const u64,
    ct: [*]const u64,
    partials: [*]const u64,
    n_partials: u32,
    out: *i32,
) callconv(.c) i32 {
    const h = handle orelse return -1;
    if (n_partials > 16) return -1;
    var received: [16]elg.Ciphertext = undefined;
    var i: u32 = 0;
    while (i < n_partials) : (i += 1) {
        received[i] = readCt(partials + i * 16);
    }
    out.* = @intCast(h.crypto.decryptFromPartials(readFr(sk), readCt(ct), received[0..n_partials]));
    return 0;
}

/// Derangement of `0..n-1` (no fixed points). `out` must hold `n` u16s.
export fn zkplayer_derangement(handle: ?*Handle, n: u32, out: [*]u16) callconv(.c) i32 {
    const h = handle orelse return -1;
    if (n == 0 or n > zk.Crypto.MAX_PERM) return -1;
    h.crypto.derangement(out[0..n]);
    return 0;
}

/// Row-major n×n permutation matrix (0/1 bytes) from a Zig derangement.
export fn zkplayer_shuffle_perm(handle: ?*Handle, n: u32, out: [*]u8) callconv(.c) i32 {
    const h = handle orelse return -1;
    if (n == 0 or n > zk.Crypto.MAX_PERM) return -1;
    const count: usize = @as(usize, n) * @as(usize, n);
    h.crypto.generateShufflePermutation(n, out[0..count]);
    return 0;
}
