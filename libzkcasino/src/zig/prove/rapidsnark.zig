const std = @import("std");
const paths_mod = @import("paths.zig");

const PROVER_OK: c_int = 0;
const PROVER_ERROR_SHORT_BUFFER: c_int = 2;
const VERIFIER_VALID: c_int = 0;

const CreateFn = *const fn (
    prover_object: *?*anyopaque,
    zkey: [*]const u8,
    zkey_size: c_ulonglong,
    err: [*]u8,
    err_max: c_ulonglong,
) callconv(.c) c_int;
const ProveFn = *const fn (
    prover_object: *anyopaque,
    wtns: [*]const u8,
    wtns_size: c_ulonglong,
    proof: [*]u8,
    proof_size: *c_ulonglong,
    public_buf: [*]u8,
    public_size: *c_ulonglong,
    err: [*]u8,
    err_max: c_ulonglong,
) callconv(.c) c_int;
const DestroyFn = *const fn (prover_object: ?*anyopaque) callconv(.c) void;
const ProofSizeFn = *const fn (out: *c_ulonglong) callconv(.c) void;
const PublicSizeBufFn = *const fn (
    zkey: [*]const u8,
    zkey_size: c_ulonglong,
    public_size: *c_ulonglong,
    err: [*]u8,
    err_max: c_ulonglong,
) callconv(.c) c_int;
const VerifyFn = *const fn (
    proof: [*:0]const u8,
    inputs: [*:0]const u8,
    vk: [*:0]const u8,
    err: [*]u8,
    err_max: c_ulong,
) callconv(.c) c_int;

pub const Proof = struct {
    proof_json: [:0]u8,
    public_json: [:0]u8,
    alloc: std.mem.Allocator,

    pub fn deinit(self: *Proof) void {
        self.alloc.free(self.proof_json);
        self.alloc.free(self.public_json);
    }
};

pub const Lib = struct {
    dyn: std.DynLib,
    create: CreateFn,
    prove: ProveFn,
    destroy: DestroyFn,
    proof_size: ProofSizeFn,
    public_size_buf: PublicSizeBufFn,
    verify: VerifyFn,

    pub fn open(lib_path: [:0]const u8) !Lib {
        var dyn = std.DynLib.open(lib_path) catch return error.RapidsnarkOpen;
        return .{
            .dyn = dyn,
            .create = dyn.lookup(CreateFn, "groth16_prover_create") orelse return error.RapidsnarkSymbol,
            .prove = dyn.lookup(ProveFn, "groth16_prover_prove") orelse return error.RapidsnarkSymbol,
            .destroy = dyn.lookup(DestroyFn, "groth16_prover_destroy") orelse return error.RapidsnarkSymbol,
            .proof_size = dyn.lookup(ProofSizeFn, "groth16_proof_size") orelse return error.RapidsnarkSymbol,
            .public_size_buf = dyn.lookup(PublicSizeBufFn, "groth16_public_size_for_zkey_buf") orelse return error.RapidsnarkSymbol,
            .verify = dyn.lookup(VerifyFn, "groth16_verify") orelse return error.RapidsnarkSymbol,
        };
    }

    pub fn close(self: *Lib) void {
        self.dyn.close();
    }

    pub fn sizes(self: *Lib, zkey: []const u8) !struct { proof: usize, public: usize } {
        var err_buf: [256]u8 = undefined;
        @memset(&err_buf, 0);
        var pub_sz: c_ulonglong = 0;
        if (self.public_size_buf(zkey.ptr, @intCast(zkey.len), &pub_sz, &err_buf, err_buf.len) != PROVER_OK) {
            return error.PublicSize;
        }
        var proof_sz: c_ulonglong = 0;
        self.proof_size(&proof_sz);
        return .{ .proof = @intCast(proof_sz + 256), .public = @intCast(pub_sz + 256) };
    }

    pub fn verifyProof(self: *Lib, proof: Proof, vk_json: [:0]const u8) !bool {
        var err_buf: [256]u8 = undefined;
        @memset(&err_buf, 0);
        const rc = self.verify(proof.proof_json, proof.public_json, vk_json, &err_buf, err_buf.len);
        return rc == VERIFIER_VALID;
    }
};

/// Stateful in-memory prover. Zkey and witness bytes passed into rapidsnark must
/// be `malloc` pointers: some BinFile builds `free()` the buffer in the destructor.
pub const Prover = struct {
    lib: *Lib,
    obj: *anyopaque,
    zkey: []u8,
    proof_cap: usize,
    public_cap: usize,

    pub fn open(lib: *Lib, zkey_path: [:0]const u8) !Prover {
        const zkey = try readFileMalloc(zkey_path);
        errdefer std.c.free(zkey.ptr);
        var err_buf: [512]u8 = undefined;
        @memset(&err_buf, 0);
        var obj: ?*anyopaque = null;
        const rc = lib.create(&obj, zkey.ptr, @intCast(zkey.len), &err_buf, err_buf.len);
        if (rc != PROVER_OK or obj == null) return error.ProverCreate;
        const sz = lib.sizes(zkey) catch {
            lib.destroy(obj);
            return error.PublicSize;
        };
        return .{
            .lib = lib,
            .obj = obj.?,
            .zkey = zkey,
            .proof_cap = sz.proof,
            .public_cap = sz.public,
        };
    }

    pub fn prove(self: *Prover, wtns: []const u8, alloc: std.mem.Allocator) !Proof {
        const c_wtns = mallocCopy(wtns) orelse return error.OutOfMemory;
        defer if (c_wtns.len != 0) std.c.free(c_wtns.ptr);
        const proof_buf = try alloc.alloc(u8, self.proof_cap);
        defer alloc.free(proof_buf);
        const public_buf = try alloc.alloc(u8, self.public_cap);
        defer alloc.free(public_buf);
        var err_buf: [512]u8 = undefined;
        @memset(&err_buf, 0);
        var proof_sz: c_ulonglong = @intCast(self.proof_cap);
        var public_sz: c_ulonglong = @intCast(self.public_cap);

        var rc = self.lib.prove(
            self.obj,
            c_wtns.ptr,
            @intCast(c_wtns.len),
            proof_buf.ptr,
            &proof_sz,
            public_buf.ptr,
            &public_sz,
            &err_buf,
            err_buf.len,
        );

        if (rc == PROVER_ERROR_SHORT_BUFFER) {
            const proof_need: usize = @intCast(proof_sz);
            const public_need: usize = @intCast(public_sz);
            const proof2 = try alloc.alloc(u8, proof_need);
            defer alloc.free(proof2);
            const public2 = try alloc.alloc(u8, public_need);
            defer alloc.free(public2);
            proof_sz = @intCast(proof_need);
            public_sz = @intCast(public_need);
            @memset(&err_buf, 0);
            rc = self.lib.prove(
                self.obj,
                c_wtns.ptr,
                @intCast(c_wtns.len),
                proof2.ptr,
                &proof_sz,
                public2.ptr,
                &public_sz,
                &err_buf,
                err_buf.len,
            );
            if (rc != PROVER_OK) {
                std.debug.print("rapidsnark prove retry rc={d} {s}\n", .{ rc, std.mem.sliceTo(&err_buf, 0) });
                return error.ProveFailed;
            }
            return finishProof(alloc, proof2[0..@intCast(proof_sz)], public2[0..@intCast(public_sz)]);
        }

        if (rc != PROVER_OK) {
            std.debug.print("rapidsnark prove rc={d} {s}\n", .{ rc, std.mem.sliceTo(&err_buf, 0) });
            return error.ProveFailed;
        }
        return finishProof(alloc, proof_buf[0..@intCast(proof_sz)], public_buf[0..@intCast(public_sz)]);
    }

    pub fn destroy(self: *Prover) void {
        self.lib.destroy(self.obj);
        // BinFile destructor may already have freed `zkey`. Leak rather than double-free.
        self.zkey = &.{};
    }
};

fn finishProof(alloc: std.mem.Allocator, proof: []const u8, public: []const u8) !Proof {
    const proof_json = try dupeZ(alloc, proof);
    errdefer alloc.free(proof_json);
    const public_json = try dupeZ(alloc, public);
    return .{ .proof_json = proof_json, .public_json = public_json, .alloc = alloc };
}

fn mallocCopy(src: []const u8) ?[]u8 {
    if (src.len == 0) return &.{};
    const raw = std.c.malloc(src.len) orelse return null;
    const dst: [*]u8 = @ptrCast(raw);
    @memcpy(dst[0..src.len], src);
    return dst[0..src.len];
}

const clib = struct {
    pub extern "c" fn fseek(stream: *std.c.FILE, offset: c_long, whence: c_int) c_int;
    pub extern "c" fn ftell(stream: *std.c.FILE) c_long;
};

fn readFileMalloc(path: [:0]const u8) ![]u8 {
    const f = std.c.fopen(path, "rb") orelse return error.ZkeyOpen;
    defer _ = std.c.fclose(f);
    if (clib.fseek(f, 0, 2) != 0) return error.ZkeySeek;
    const size = clib.ftell(f);
    if (size < 0) return error.ZkeySeek;
    if (clib.fseek(f, 0, 0) != 0) return error.ZkeySeek;
    const n: usize = @intCast(size);
    const raw = std.c.malloc(n) orelse return error.OutOfMemory;
    const buf: [*]u8 = @ptrCast(raw);
    const got = std.c.fread(buf, 1, n, f);
    if (got != n) {
        std.c.free(raw);
        return error.ZkeyRead;
    }
    return buf[0..n];
}

fn dupeZ(alloc: std.mem.Allocator, s: []const u8) ![:0]u8 {
    const out = try alloc.allocSentinel(u8, s.len, 0);
    @memcpy(out, s);
    return out;
}

pub fn exists(p: paths_mod.Paths) bool {
    const path = std.fmt.allocPrintSentinel(p.alloc, "{s}", .{p.rapidsnark}, 0) catch return false;
    defer p.alloc.free(path);
    return paths_mod.exists(path);
}
