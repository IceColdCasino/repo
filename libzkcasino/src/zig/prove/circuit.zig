const std = @import("std");
const paths_mod = @import("paths.zig");
const spec_mod = @import("spec.zig");
const witness_mod = @import("witness.zig");
const rs_mod = @import("rapidsnark.zig");

pub const Paths = paths_mod.Paths;
pub const CircuitId = spec_mod.CircuitId;
pub const Proof = rs_mod.Proof;
pub const json = @import("json.zig");

const CachedCircuit = struct {
    handle: *anyopaque,
    wit: *witness_mod.Lib,
    prover: rs_mod.Prover,
    vk_json: [:0]u8,
    short_z: [:0]u8,
};

pub const Engine = struct {
    alloc: std.mem.Allocator,
    paths: Paths,
    rapidsnark: rs_mod.Lib,
    libs: std.StringHashMap(*witness_mod.Lib),
    circuits: std.AutoHashMap(CircuitId, CachedCircuit),

    pub fn init(alloc: std.mem.Allocator) !Engine {
        var paths = try Paths.resolve(alloc);
        errdefer paths.deinit();
        const rs_path = try std.fmt.allocPrintSentinel(alloc, "{s}", .{paths.rapidsnark}, 0);
        defer alloc.free(rs_path);
        var rapidsnark = try rs_mod.Lib.open(rs_path);
        errdefer rapidsnark.close();
        return .{
            .alloc = alloc,
            .paths = paths,
            .rapidsnark = rapidsnark,
            .libs = .init(alloc),
            .circuits = .init(alloc),
        };
    }

    pub fn deinit(self: *Engine) void {
        var cit = self.circuits.iterator();
        while (cit.next()) |e| {
            // Circom `release_memory_component` already delete[]s subcomponent
            // arrays and leaves dangling pointers; `zkcasino_free` double-frees.
            e.value_ptr.prover.destroy();
            self.alloc.free(e.value_ptr.vk_json);
            self.alloc.free(e.value_ptr.short_z);
        }
        self.circuits.deinit();

        var lit = self.libs.iterator();
        while (lit.next()) |e| {
            e.value_ptr.*.close();
            self.alloc.destroy(e.value_ptr.*);
        }
        self.libs.deinit();
        self.rapidsnark.close();
        self.paths.deinit();
    }

    fn getLib(self: *Engine, lib_name: []const u8) !*witness_mod.Lib {
        if (self.libs.get(lib_name)) |lib| return lib;
        const path = try self.paths.witnessLib(self.alloc, lib_name);
        defer self.alloc.free(path);
        const lib = try self.alloc.create(witness_mod.Lib);
        errdefer self.alloc.destroy(lib);
        lib.* = try witness_mod.Lib.open(path, self.paths.dat_dir);
        try self.libs.put(lib_name, lib);
        return lib;
    }

    fn getCached(self: *Engine, id: CircuitId) !*CachedCircuit {
        if (self.circuits.getPtr(id)) |c| return c;
        const s = id.spec();
        const wit = try self.getLib(s.lib);
        const short_z = try self.alloc.dupeZ(u8, s.short);
        errdefer self.alloc.free(short_z);
        const handle = try wit.create(short_z);
        const zkey = try self.paths.zkeyFile(self.alloc, s.zkey);
        defer self.alloc.free(zkey);
        const prover = try rs_mod.Prover.open(&self.rapidsnark, zkey);
        const vk_path = try self.paths.vkFile(self.alloc, s.zkey);
        defer self.alloc.free(vk_path);
        const vk_json = try readFileZ(self.alloc, vk_path);
        try self.circuits.put(id, .{
            .handle = handle,
            .wit = wit,
            .prover = prover,
            .vk_json = vk_json,
            .short_z = short_z,
        });
        return self.circuits.getPtr(id).?;
    }

    pub fn proveJson(self: *Engine, id: CircuitId, input_json: []const u8) !Proof {
        const c = try self.getCached(id);
        const wtns = try c.wit.generateWtns(c.handle, input_json, self.alloc);
        defer self.alloc.free(wtns);
        return c.prover.prove(wtns, self.alloc);
    }

    pub fn verify(self: *Engine, id: CircuitId, proof: Proof) !bool {
        const c = try self.getCached(id);
        return self.rapidsnark.verifyProof(proof, c.vk_json);
    }

    pub fn available(self: *Engine, id: CircuitId) bool {
        const s = id.spec();
        if (!witness_mod.exists(self.paths, self.alloc, s.lib)) return false;
        const zkey = self.paths.zkeyFile(self.alloc, s.zkey) catch return false;
        defer self.alloc.free(zkey);
        return paths_mod.exists(zkey);
    }
};

const clib = struct {
    pub extern "c" fn fseek(stream: *std.c.FILE, offset: c_long, whence: c_int) c_int;
    pub extern "c" fn ftell(stream: *std.c.FILE) c_long;
};

fn readFileZ(alloc: std.mem.Allocator, path: [:0]const u8) ![:0]u8 {
    const f = std.c.fopen(path, "rb") orelse return error.VkOpen;
    defer _ = std.c.fclose(f);
    if (clib.fseek(f, 0, 2) != 0) return error.VkSeek;
    const size = clib.ftell(f);
    if (size < 0) return error.VkSeek;
    if (clib.fseek(f, 0, 0) != 0) return error.VkSeek;
    const n: usize = @intCast(size);
    const buf = try alloc.allocSentinel(u8, n, 0);
    const got = std.c.fread(buf.ptr, 1, n, f);
    if (got != n) {
        alloc.free(buf);
        return error.VkRead;
    }
    return buf;
}
