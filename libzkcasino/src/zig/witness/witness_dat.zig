const std = @import("std");
const c = std.c;

const clib = struct {
    pub extern "c" fn fopen(path: [*c]const u8, mode: [*c]const u8) ?*anyopaque;
    pub extern "c" fn fclose(stream: ?*anyopaque) c_int;
    pub extern "c" fn fseek(stream: ?*anyopaque, offset: c_long, whence: c_int) c_int;
    pub extern "c" fn ftell(stream: ?*anyopaque) c_long;
    pub extern "c" fn fread(ptr: ?*anyopaque, size: usize, nmemb: usize, stream: ?*anyopaque) usize;
};

const SEEK_END: c_int = 2;
const SEEK_SET: c_int = 0;

const max_root_bytes = 4096;
var dat_root: [max_root_bytes]u8 = undefined;
var dat_root_len: usize = 0;

var cache: std.StringHashMapUnmanaged([]u8) = .{};
var cache_mutex: std.atomic.Mutex = .unlocked;

fn lockCache(m: *std.atomic.Mutex) void {
    while (!m.tryLock()) {
        std.Thread.yield() catch {};
    }
}

pub fn setDatRoot(path: []const u8) void {
    const count = @min(path.len, max_root_bytes);
    @memcpy(dat_root[0..count], path[0..count]);
    dat_root_len = count;
}

fn readFileAll(path: [:0]const u8) ![]u8 {
    const file = clib.fopen(path.ptr, "rb") orelse return error.FileNotFound;
    defer _ = clib.fclose(file);
    if (clib.fseek(file, 0, SEEK_END) != 0) return error.FileSeekFailed;
    const size = clib.ftell(file);
    if (size < 0) return error.FileSeekFailed;
    if (clib.fseek(file, 0, SEEK_SET) != 0) return error.FileSeekFailed;
    const bytes = try std.heap.c_allocator.alloc(u8, @intCast(size));
    errdefer std.heap.c_allocator.free(bytes);
    const read_count = clib.fread(bytes.ptr, 1, @intCast(size), file);
    if (read_count != @as(usize, @intCast(size))) return error.UnexpectedEndOfFile;
    return bytes;
}

fn loadDatFromRoot(circuit_name: []const u8) ![]const u8 {
    if (dat_root_len == 0) return error.DatRootUnset;

    lockCache(&cache_mutex);
    defer cache_mutex.unlock();

    if (cache.get(circuit_name)) |bytes| {
        return bytes;
    }

    var path_buf: [max_root_bytes + 64 + 1]u8 = undefined;
    const rel = try std.fmt.bufPrintZ(&path_buf, "{s}/{s}.dat", .{
        dat_root[0..dat_root_len],
        circuit_name,
    });
    const bytes = try readFileAll(rel);

    const key = try std.heap.c_allocator.dupe(u8, circuit_name);
    errdefer std.heap.c_allocator.free(key);
    try cache.put(std.heap.c_allocator, key, bytes);
    return bytes;
}

/// Load `{dat_root}/{circuit_name}.dat`. Call `zkcasino_set_dat_root` before init.
pub fn getCircuitDat(circuit_name: []const u8) ![]const u8 {
    return loadDatFromRoot(circuit_name);
}

pub export fn zkcasino_set_dat_root(path: ?[*]const u8, len: usize) void {
    const ptr = path orelse return;
    if (len == 0 or len > max_root_bytes) return;
    setDatRoot(ptr[0..len]);
}
