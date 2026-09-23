const std = @import("std");
const builtin = @import("builtin");

pub const dylib_suffix = if (builtin.os.tag == .macos or builtin.os.tag == .ios) "dylib" else "so";

pub const Paths = struct {
    repo: []const u8,
    lib_dir: []const u8,
    dat_dir: []const u8,
    zkey_dir: []const u8,
    rapidsnark: []const u8,
    alloc: std.mem.Allocator,

    pub fn resolve(alloc: std.mem.Allocator) !Paths {
        const repo = try findRepo(alloc);
        errdefer alloc.free(repo);

        const lib_dir = try envOrJoin(alloc, "ZKCASINO_LIB_DIR", repo, "libzkcasino/zig-out/lib");
        errdefer alloc.free(lib_dir);
        const dat_dir = try envOrJoin(alloc, "ZKCASINO_DAT_ROOT", repo, "libzkcasino/src/zig/dat");
        errdefer alloc.free(dat_dir);
        const zkey_dir = try envOrJoin(alloc, "ZK_ZKEY_DIR", repo, "zkey");
        errdefer alloc.free(zkey_dir);
        const rapidsnark = try envOrJoin(alloc, "RAPIDSNARK_LIB", repo, "rapidsnark/lib/librapidsnark." ++ dylib_suffix);
        errdefer alloc.free(rapidsnark);

        return .{
            .repo = repo,
            .lib_dir = lib_dir,
            .dat_dir = dat_dir,
            .zkey_dir = zkey_dir,
            .rapidsnark = rapidsnark,
            .alloc = alloc,
        };
    }

    pub fn deinit(self: *Paths) void {
        self.alloc.free(self.repo);
        self.alloc.free(self.lib_dir);
        self.alloc.free(self.dat_dir);
        self.alloc.free(self.zkey_dir);
        self.alloc.free(self.rapidsnark);
    }

    pub fn witnessLib(self: Paths, alloc: std.mem.Allocator, lib_name: []const u8) ![:0]u8 {
        return std.fmt.allocPrintSentinel(alloc, "{s}/lib{s}.{s}", .{ self.lib_dir, lib_name, dylib_suffix }, 0);
    }

    pub fn zkeyFile(self: Paths, alloc: std.mem.Allocator, zkey_name: []const u8) ![:0]u8 {
        return std.fmt.allocPrintSentinel(alloc, "{s}/{s}_0001.zkey", .{ self.zkey_dir, zkey_name }, 0);
    }

    pub fn vkFile(self: Paths, alloc: std.mem.Allocator, zkey_name: []const u8) ![:0]u8 {
        return std.fmt.allocPrintSentinel(alloc, "{s}/{s}_verification_key.json", .{ self.zkey_dir, zkey_name }, 0);
    }
};

fn envOrJoin(alloc: std.mem.Allocator, env: [:0]const u8, repo: []const u8, rel: []const u8) ![]u8 {
    if (getenvDup(alloc, env)) |v| return v;
    return std.fmt.allocPrint(alloc, "{s}/{s}", .{ repo, rel });
}

fn getenvDup(alloc: std.mem.Allocator, key: [:0]const u8) ?[]u8 {
    const v = std.c.getenv(key) orelse return null;
    return alloc.dupe(u8, std.mem.span(v)) catch null;
}

fn findRepo(alloc: std.mem.Allocator) ![]u8 {
    if (getenvDup(alloc, "ZK_REPO_ROOT")) |v| return v;

    var buf: [4096]u8 = undefined;
    if (std.c.getcwd(&buf, buf.len) == null) return error.CwdUnavailable;
    const cwd_len = std.mem.indexOfScalar(u8, &buf, 0) orelse buf.len;
    var dir = try alloc.dupe(u8, buf[0..cwd_len]);
    while (true) {
        if (existsJoin(dir, "zkey/register_main_0001.zkey")) return dir;
        const parent = std.fs.path.dirname(dir) orelse {
            alloc.free(dir);
            return error.RepoRootNotFound;
        };
        if (std.mem.eql(u8, parent, dir)) {
            alloc.free(dir);
            return error.RepoRootNotFound;
        }
        const next = try alloc.dupe(u8, parent);
        alloc.free(dir);
        dir = next;
    }
}

fn existsJoin(dir: []const u8, rel: []const u8) bool {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrintSentinel(&buf, "{s}/{s}", .{ dir, rel }, 0) catch return false;
    const f = std.c.fopen(path, "rb") orelse return false;
    _ = std.c.fclose(f);
    return true;
}

pub fn exists(path: [:0]const u8) bool {
    const f = std.c.fopen(path, "rb") orelse return false;
    _ = std.c.fclose(f);
    return true;
}
