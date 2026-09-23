const std = @import("std");
const paths_mod = @import("paths.zig");

const InitFn = *const fn (name: [*:0]const u8) callconv(.c) ?*anyopaque;
const GenerateFn = *const fn (
    handle: *anyopaque,
    json: [*]const u8,
    json_len: u32,
    output: ?[*]u8,
    output_len: *u32,
) callconv(.c) c_int;
const SetDatFn = *const fn (path: [*]const u8, len: u64) callconv(.c) void;
const FreeFn = *const fn (handle: ?*anyopaque) callconv(.c) void;

pub const Lib = struct {
    dyn: std.DynLib,
    init: InitFn,
    generate: GenerateFn,
    free: FreeFn,

    pub fn open(lib_path: [:0]const u8, dat_root: []const u8) !Lib {
        var dyn = std.DynLib.open(lib_path) catch {
            std.debug.print("witness lib open failed: {s}\n", .{lib_path});
            if (std.c.dlerror()) |msg| std.debug.print("dlerror: {s}\n", .{std.mem.span(msg)});
            return error.WitnessLibOpen;
        };
        const init_fn = dyn.lookup(InitFn, "zkcasino_init") orelse return error.WitnessSymbol;
        const generate = dyn.lookup(GenerateFn, "zkcasino_generate_wtns") orelse return error.WitnessSymbol;
        const free = dyn.lookup(FreeFn, "zkcasino_free") orelse return error.WitnessSymbol;
        if (dyn.lookup(SetDatFn, "zkcasino_set_dat_root")) |set_dat| {
            set_dat(dat_root.ptr, @intCast(dat_root.len));
        }
        return .{ .dyn = dyn, .init = init_fn, .generate = generate, .free = free };
    }

    pub fn close(self: *Lib) void {
        self.dyn.close();
    }

    pub fn create(self: *Lib, short_name: [:0]const u8) !*anyopaque {
        return self.init(short_name) orelse error.WitnessInit;
    }

    pub fn generateWtns(self: *Lib, handle: *anyopaque, json: []const u8, alloc: std.mem.Allocator) ![]u8 {
        var size: u32 = 0;
        const q = self.generate(handle, json.ptr, @intCast(json.len), null, &size);
        if (q != 0) {
            std.debug.print("zkcasino_generate_wtns size rc={d}\n", .{q});
            return error.WitnessSize;
        }
        const out = try alloc.alloc(u8, size);
        errdefer alloc.free(out);
        var wrote = size;
        const rc = self.generate(handle, json.ptr, @intCast(json.len), out.ptr, &wrote);
        if (rc != 0) return error.WitnessGenerate;
        return out[0..wrote];
    }
};

pub fn exists(p: paths_mod.Paths, alloc: std.mem.Allocator, lib_name: []const u8) bool {
    const path = p.witnessLib(alloc, lib_name) catch return false;
    defer alloc.free(path);
    return paths_mod.exists(path);
}
