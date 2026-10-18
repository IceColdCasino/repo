const std = @import("std");
const build_options = @import("build_options");
const zero_native = @import("zero-native");

const DEFAULT_PORT: u16 = 3847;
const CHAIN_WORKER_PORT: u16 = 3850;

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

    fn isListening(self: *State, port: u16) bool {
        const io = self.io orelse return false;
        const addr = std.Io.net.IpAddress.parseIp4("127.0.0.1", port) catch return false;
        const stream = std.Io.net.IpAddress.connect(&addr, io, .{ .mode = .stream }) catch return false;
        stream.close(io);
        return true;
    }
};

pub fn healthHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *State = @ptrCast(@alignCast(context));
    if (self.isListening(DEFAULT_PORT)) {
        return std.fmt.bufPrint(output, "{{\"ok\":true,\"port\":{d}}}", .{DEFAULT_PORT});
    }
    return std.fmt.bufPrint(output, "{{\"ok\":false,\"port\":{d}}}", .{DEFAULT_PORT});
}

pub fn startHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *State = @ptrCast(@alignCast(context));

    if (self.isListening(DEFAULT_PORT)) {
        return std.fmt.bufPrint(output, "{{\"ok\":true,\"alreadyRunning\":true,\"port\":{d}}}", .{DEFAULT_PORT});
    }

    return std.fmt.bufPrint(
        output,
        "{{\"ok\":false,\"error\":\"The app does not launch Bun. Start the game server on the host, then Connect.\"}}",
        .{},
    );
}

pub fn chainWorkerHealthHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *State = @ptrCast(@alignCast(context));
    if (self.isListening(CHAIN_WORKER_PORT)) {
        return std.fmt.bufPrint(output, "{{\"ok\":true,\"port\":{d}}}", .{CHAIN_WORKER_PORT});
    }
    return std.fmt.bufPrint(output, "{{\"ok\":false,\"port\":{d}}}", .{CHAIN_WORKER_PORT});
}

pub fn chainWorkerStartHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *State = @ptrCast(@alignCast(context));

    if (self.isListening(CHAIN_WORKER_PORT)) {
        return std.fmt.bufPrint(output, "{{\"ok\":true,\"alreadyRunning\":true,\"port\":{d}}}", .{CHAIN_WORKER_PORT});
    }

    return std.fmt.bufPrint(
        output,
        "{{\"ok\":false,\"error\":\"The app does not launch Bun. Start the chain worker on the host if you need it.\"}}",
        .{},
    );
}

const bridge_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5178",
};

pub fn bridgePolicy() [4]zero_native.BridgeCommandPolicy {
    return .{
        .{ .name = "server.start", .origins = &bridge_origins },
        .{ .name = "server.health", .origins = &bridge_origins },
        .{ .name = "chainWorker.start", .origins = &bridge_origins },
        .{ .name = "chainWorker.health", .origins = &bridge_origins },
    };
}

pub fn registerHandlers(state: *State, handlers: *[4]zero_native.BridgeHandler) void {
    handlers.* = .{
        .{ .name = "server.start", .context = state, .invoke_fn = startHandler },
        .{ .name = "server.health", .context = state, .invoke_fn = healthHandler },
        .{ .name = "chainWorker.start", .context = state, .invoke_fn = chainWorkerStartHandler },
        .{ .name = "chainWorker.health", .context = state, .invoke_fn = chainWorkerHealthHandler },
    };
}
