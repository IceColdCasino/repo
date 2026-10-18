const std = @import("std");
const build_options = @import("build_options");
const zero_native = @import("zero-native");

/// Native Solana bridges for the WebView:
/// - `solana.meta` — read/write `.local/*.json` (base64 value) for dual-client coordination
/// - `solana.op` — rejected; mutations run in WebView JS via `executePerSeatOp` → RPC
///
/// The macOS/iOS apps never spawn Bun.

pub const State = struct {
    io: ?std.Io = null,
    repo_root: []const u8,

    pub fn init(io: std.Io, env_map: *std.process.Environ.Map, alloc: std.mem.Allocator) !State {
        const repo_root = if (env_map.get("ZK_REPO_ROOT")) |value|
            try alloc.dupe(u8, value)
        else
            try alloc.dupe(u8, build_options.repo_root);
        return .{
            .io = io,
            .repo_root = repo_root,
        };
    }

    pub fn initEmbedded(alloc: std.mem.Allocator) !State {
        return .{
            .io = null,
            .repo_root = try alloc.dupe(u8, ""),
        };
    }

    pub fn deinit(self: *State, alloc: std.mem.Allocator) void {
        alloc.free(self.repo_root);
    }
};

fn copyPayload(output: []u8, src: []const u8) ![]const u8 {
    if (src.len > output.len) return error.BufferTooSmall;
    @memcpy(output[0..src.len], src);
    return output[0..src.len];
}

/// Extract a JSON string field `"key":"..."` (handles `\"` escapes).
fn jsonStringField(payload: []const u8, field: []const u8) ?[]const u8 {
    var needle_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"{s}\"", .{field}) catch return null;
    const start = std.mem.indexOf(u8, payload, needle) orelse return null;
    var i = start + needle.len;
    while (i < payload.len and (payload[i] == ' ' or payload[i] == ':' or payload[i] == '\t')) : (i += 1) {}
    if (i >= payload.len or payload[i] != '"') return null;
    i += 1;
    const value_start = i;
    while (i < payload.len) : (i += 1) {
        if (payload[i] == '\\' and i + 1 < payload.len) {
            i += 1;
            continue;
        }
        if (payload[i] == '"') {
            return payload[value_start..i];
        }
    }
    return null;
}

fn metaPath(self: *State, key: []const u8, out: []u8) ![]const u8 {
    for (key) |c| {
        const ok = (c >= 'a' and c <= 'z')
            or (c >= 'A' and c <= 'Z')
            or (c >= '0' and c <= '9')
            or c == '-' or c == '_';
        if (!ok) return error.InvalidMetaKey;
    }
    const suffix = if (std.mem.endsWith(u8, key, ".json")) "" else ".json";
    return try std.fmt.bufPrint(out, "{s}/.local/{s}{s}", .{ self.repo_root, key, suffix });
}

/// libc file IO with explicit fclose — Zig `Io.Dir.readFile/writeFile` was leaking
/// FDs under rapid dual-WebView `solana.meta` polling (`write: ProcessFdQuotaExceeded`).
const clib = struct {
    pub extern "c" fn fopen(filename: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
    pub extern "c" fn fclose(stream: ?*anyopaque) c_int;
    pub extern "c" fn fread(ptr: [*]u8, size: usize, count: usize, stream: ?*anyopaque) usize;
    pub extern "c" fn fwrite(ptr: [*]const u8, size: usize, count: usize, stream: ?*anyopaque) usize;
    pub extern "c" fn remove(filename: [*:0]const u8) c_int;
};

fn pathToZ(path: []const u8, out: *[1025]u8) ![*:0]const u8 {
    if (path.len >= out.len) return error.NameTooLong;
    @memcpy(out[0..path.len], path);
    out[path.len] = 0;
    return out[0..path.len :0].ptr;
}

fn metaReadFile(path: []const u8, buf: []u8) ![]const u8 {
    var zbuf: [1025]u8 = undefined;
    const zpath = try pathToZ(path, &zbuf);
    const fp = clib.fopen(zpath, "rb") orelse return error.FileNotFound;
    defer _ = clib.fclose(fp);
    const n = clib.fread(buf.ptr, 1, buf.len, fp);
    if (n == 0) return error.FileNotFound;
    return buf[0..n];
}

fn metaWriteFile(path: []const u8, data: []const u8) !void {
    var zbuf: [1025]u8 = undefined;
    const zpath = try pathToZ(path, &zbuf);
    const fp = clib.fopen(zpath, "wb") orelse return error.AccessDenied;
    defer _ = clib.fclose(fp);
    const n = clib.fwrite(data.ptr, 1, data.len, fp);
    if (n != data.len) return error.WriteFailed;
}

fn metaDeleteFile(path: []const u8) void {
    var zbuf: [1025]u8 = undefined;
    const zpath = pathToZ(path, &zbuf) catch return;
    _ = clib.remove(zpath);
}

pub fn solanaMetaHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *State = @ptrCast(@alignCast(context));

    if (build_options.is_ios) {
        return try std.fmt.bufPrint(output, "{{\"error\":\"solana.meta runs on the macOS host\"}}", .{});
    }
    // Meta uses libc fopen (no Io) so FD leaks from Io.Dir cannot stall join/register.
    if (self.io == null and self.repo_root.len == 0) {
        return try std.fmt.bufPrint(output, "{{\"error\":\"UnsupportedPlatform\"}}", .{});
    }

    const payload = invocation.request.payload;
    const action = jsonStringField(payload, "action") orelse {
        return try std.fmt.bufPrint(output, "{{\"error\":\"missing action\"}}", .{});
    };
    const key = jsonStringField(payload, "key") orelse {
        return try std.fmt.bufPrint(output, "{{\"error\":\"missing key\"}}", .{});
    };

    var path_buf: [1024]u8 = undefined;
    const path = metaPath(self, key, &path_buf) catch {
        return try std.fmt.bufPrint(output, "{{\"error\":\"invalid key\"}}", .{});
    };

    if (std.mem.eql(u8, action, "get")) {
        // Hand meta is small (<<1MB); keep stack modest.
        var file_buf: [512 * 1024]u8 = undefined;
        const data = metaReadFile(path, &file_buf) catch {
            return try copyPayload(output, "{\"ok\":true,\"value\":null,\"encoding\":\"base64\"}");
        };
        const enc_len = std.base64.standard.Encoder.calcSize(data.len);
        if (enc_len + 64 > output.len) return error.BufferTooSmall;
        const b64_buf = try std.heap.page_allocator.alloc(u8, enc_len);
        defer std.heap.page_allocator.free(b64_buf);
        const encoded = std.base64.standard.Encoder.encode(b64_buf, data);
        return try std.fmt.bufPrint(output, "{{\"ok\":true,\"value\":\"{s}\",\"encoding\":\"base64\"}}", .{encoded});
    }

    if (std.mem.eql(u8, action, "remove")) {
        metaDeleteFile(path);
        return try copyPayload(output, "{\"ok\":true}");
    }

    if (std.mem.eql(u8, action, "set")) {
        const b64 = jsonStringField(payload, "value") orelse {
            return try std.fmt.bufPrint(output, "{{\"error\":\"missing value\"}}", .{});
        };
        const dec_len = std.base64.standard.Decoder.calcSizeForSlice(b64) catch {
            return try std.fmt.bufPrint(output, "{{\"error\":\"invalid base64\"}}", .{});
        };
        const decoded = try std.heap.page_allocator.alloc(u8, dec_len);
        defer std.heap.page_allocator.free(decoded);
        _ = std.base64.standard.Decoder.decode(decoded, b64) catch {
            return try std.fmt.bufPrint(output, "{{\"error\":\"base64 decode failed\"}}", .{});
        };

        // `.local/` is created by E2E/orchestrator scripts; write fails clearly if missing.
        metaWriteFile(path, decoded) catch |err| {
            return try std.fmt.bufPrint(output, "{{\"error\":\"meta-write: {s}\"}}", .{@errorName(err)});
        };
        return try copyPayload(output, "{\"ok\":true}");
    }

    return try std.fmt.bufPrint(output, "{{\"error\":\"unknown action\"}}", .{});
}

pub fn solanaOpHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = context;
    _ = invocation;
    return try copyPayload(output, "{\"error\":\"solana.op is not available — Solana mutations run in WebView JS (executePerSeatOp). The app does not launch Bun.\"}");
}

const bridge_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5178",
};

pub fn bridgePolicy() [2]zero_native.BridgeCommandPolicy {
    return .{
        .{ .name = "solana.meta", .origins = &bridge_origins },
        .{ .name = "solana.op", .origins = &bridge_origins },
    };
}

pub fn registerHandlers(state: *State, handlers: *[2]zero_native.BridgeHandler) void {
    handlers.* = .{
        .{ .name = "solana.meta", .context = state, .invoke_fn = solanaMetaHandler },
        .{ .name = "solana.op", .context = state, .invoke_fn = solanaOpHandler },
    };
}
