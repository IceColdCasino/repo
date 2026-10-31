//! On-disk zkeys are either a raw `zkey` file or `zkx1`:
//! 4-byte magic, u64le uncompressed length, then an xz stream of the raw key.
//! `plainPath` expands xz into the cache once and returns a path whose bytes
//! are the proving key the library already reads.
const std = @import("std");
const builtin = @import("builtin");

const store_magic = "zkx1";
const raw_magic = "zkey";

extern "c" fn popen(command: [*:0]const u8, mode: [*:0]const u8) ?*std.c.FILE;
extern "c" fn pclose(stream: *std.c.FILE) c_int;
extern "c" fn access(path: [*:0]const u8, mode: c_int) c_int;

/// Seconds and bytes. Linux has no `std.c.Stat` (it is `void`); `statx` fills this.
const Stamp = struct {
    mtime_sec: i64,
    size: u64,
};

fn stampAt(path: [*:0]const u8) !Stamp {
    if (comptime builtin.os.tag == .linux) {
        var stx = std.mem.zeroes(std.os.linux.Statx);
        const rc = std.os.linux.statx(std.posix.AT.FDCWD, path, 0, .{ .MTIME = true, .SIZE = true }, &stx);
        if (std.os.linux.errno(rc) != .SUCCESS) return error.ZkeyStat;
        return .{ .mtime_sec = stx.mtime.sec, .size = stx.size };
    } else {
        const c = struct {
            extern "c" fn fstatat(dirfd: c_int, path: [*:0]const u8, buf: *std.c.Stat, flag: c_int) c_int;
        };
        var st: std.c.Stat = undefined;
        if (c.fstatat(std.posix.AT.FDCWD, path, &st, 0) != 0) return error.ZkeyStat;
        return .{ .mtime_sec = st.mtime().sec, .size = @intCast(st.size) };
    }
}

fn xzBin() [:0]const u8 {
    const candidates = [_][:0]const u8{
        "/opt/homebrew/bin/xz",
        "/usr/local/bin/xz",
    };
    for (candidates) |path| {
        if (access(path, 1) == 0) return path;
    }
    return "xz";
}

fn cacheDir(alloc: std.mem.Allocator) ![:0]u8 {
    if (std.c.getenv("HOME")) |home| {
        if (comptime @import("builtin").os.tag == .macos) {
            return std.fmt.allocPrintSentinel(alloc, "{s}/Library/Caches/IceColdCasino/zkey", .{std.mem.span(home)}, 0);
        }
    }
    return alloc.dupeSentinel(u8, "/tmp/icecoldcasino-zkey", 0);
}

fn quote(alloc: std.mem.Allocator, path: []const u8) ![:0]u8 {
    if (std.mem.indexOfScalar(u8, path, '\'') != null) return error.ZkeyPath;
    return std.fmt.allocPrintSentinel(alloc, "'{s}'", .{path}, 0);
}

/// Path of the raw proving key. A `zkx1` file is expanded into the cache.
pub fn plainPath(alloc: std.mem.Allocator, stored: [:0]const u8) ![:0]u8 {
    const file = std.c.fopen(stored, "rb") orelse return error.ZkeyOpen;
    var head: [12]u8 = undefined;
    const n = std.c.fread(&head, 1, head.len, file);
    _ = std.c.fclose(file);
    if (n >= 4 and std.mem.eql(u8, head[0..4], raw_magic)) {
        return alloc.dupeSentinel(u8, stored, 0);
    }
    if (n < 12 or !std.mem.eql(u8, head[0..4], store_magic)) return error.ZkeyFormat;

    const uncompressed: u64 = std.mem.readInt(u64, head[4..12], .little);
    const st = try stampAt(stored);
    const dir = try cacheDir(alloc);
    defer alloc.free(dir);
    const base = std.fs.path.basename(stored);
    const cache = try std.fmt.allocPrintSentinel(alloc, "{s}/{s}.{d}.{d}.zkey", .{
        dir,
        base,
        st.mtime_sec,
        st.size,
    }, 0);
    errdefer alloc.free(cache);

    if (stampAt(cache)) |cached| {
        if (cached.size == uncompressed) return cache;
    } else |_| {}

    const partial = try std.fmt.allocPrintSentinel(alloc, "{s}.partial", .{cache}, 0);
    defer alloc.free(partial);
    const xz = xzBin();
    const q_dir = try quote(alloc, dir);
    defer alloc.free(q_dir);
    const q_stored = try quote(alloc, stored);
    defer alloc.free(q_stored);
    const q_partial = try quote(alloc, partial);
    defer alloc.free(q_partial);
    const q_cache = try quote(alloc, cache);
    defer alloc.free(q_cache);
    const q_xz = try quote(alloc, xz);
    defer alloc.free(q_xz);

    const cmd = try std.fmt.allocPrintSentinel(alloc, "mkdir -p {s} && tail -c +13 {s} | {s} -dc > {s} && mv {s} {s}", .{
        q_dir,
        q_stored,
        q_xz,
        q_partial,
        q_partial,
        q_cache,
    }, 0);
    defer alloc.free(cmd);

    const pipe = popen(cmd, "r") orelse return error.ZkeyExpand;
    const rc = pclose(pipe);
    if (rc != 0) return error.ZkeyExpand;
    const expanded = stampAt(cache) catch return error.ZkeyExpand;
    if (expanded.size != uncompressed) return error.ZkeyExpand;
    return cache;
}

test "plain path starts with the zkey magic" {
    const stored: [:0]const u8 = "zkey/register_main_0001.zkey";
    if (std.c.fopen(stored, "rb")) |existing| {
        _ = std.c.fclose(existing);
    } else return;
    const plain = try plainPath(std.testing.allocator, stored);
    defer std.testing.allocator.free(plain);
    const out = std.c.fopen(plain, "rb") orelse return error.ZkeyOpen;
    defer _ = std.c.fclose(out);
    var head: [4]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 4), std.c.fread(&head, 1, 4, out));
    try std.testing.expectEqualStrings("zkey", &head);
}
