const std = @import("std");
const zero_native = @import("zero-native");
const app_core = @import("app_core");

const max_asset_root_bytes: usize = 4096;
const max_asset_entry_bytes: usize = 256;
const max_bridge_message_bytes: usize = 1024 * 1024;
const max_bridge_response_bytes: usize = 1024 * 1024;

var active_host_app: ?*IosHostApp = null;


fn lockBridgeResponse(lock: *std.atomic.Mutex) void {
    while (!lock.tryLock()) {
        std.Thread.yield() catch {};
    }
}

fn unlockBridgeResponse(lock: *std.atomic.Mutex) void {
    lock.unlock();
}

const IosHostApp = struct {
    null_platform: zero_native.NullPlatform,
    runtime: zero_native.Runtime,
    poker_app: app_core.App,
    last_error: ?anyerror = null,
    asset_root: [max_asset_root_bytes]u8 = undefined,
    asset_root_len: usize = 0,
    zkey_root: [max_asset_root_bytes]u8 = undefined,
    zkey_root_len: usize = 0,
    asset_entry: [max_asset_entry_bytes]u8 = undefined,
    asset_entry_len: usize = 0,
    bridge_message: [max_bridge_message_bytes]u8 = undefined,
    bridge_message_len: usize = 0,
    loaded_asset_root: [max_asset_root_bytes]u8 = undefined,
    loaded_asset_root_len: usize = 0,
    loaded_asset_entry: [max_asset_entry_bytes]u8 = undefined,
    loaded_asset_entry_len: usize = 0,
    loaded_source_kind: c_int = -1,
    bridge_response_mutex: std.atomic.Mutex = .unlocked,
    bridge_response: [max_bridge_response_bytes]u8 = undefined,
    bridge_response_len: usize = 0,
    bridge_response_serial: u64 = 0,
    last_bridge_response_serial: u64 = 0,

    fn create() !*IosHostApp {
        const allocator = std.heap.page_allocator;
        const self = try allocator.create(IosHostApp);
        self.* = .{
            .null_platform = zero_native.NullPlatform.init(.{}),
            .runtime = undefined,
            .poker_app = try app_core.App.initEmbedded(allocator),
            .last_error = null,
            .asset_root = undefined,
            .asset_root_len = 0,
            .asset_entry = undefined,
            .asset_entry_len = 0,
            .bridge_message = undefined,
            .bridge_message_len = 0,
        };
        @memset(&self.asset_entry, 0);
        const default_entry = "index.html";
        @memcpy(self.asset_entry[0..default_entry.len], default_entry);
        self.asset_entry_len = default_entry.len;
        self.runtime = zero_native.Runtime.init(.{
            .platform = self.null_platform.platform(),
            .bridge = self.poker_app.bridge(),
            .security = .{
                .navigation = .{ .allowed_origins = &app_core.ios_origins },
            },
        });
        return self;
    }

    fn applyAssetConfig(self: *IosHostApp) void {
        if (self.asset_root_len > 0) {
            self.poker_app.setAssetRoot(self.asset_root[0..self.asset_root_len]);
        }
        if (self.zkey_root_len > 0) {
            self.poker_app.setZkeyRoot(self.zkey_root[0..self.zkey_root_len]);
        }
        if (self.asset_entry_len > 0) {
            self.poker_app.setAssetEntry(self.asset_entry[0..self.asset_entry_len]);
        }
    }

    fn recordError(self: *IosHostApp, err: anyerror) void {
        self.last_error = err;
    }

    fn dispatchBridge(self: *IosHostApp, bytes: []const u8) void {
        // Copy so Swift withCString temporaries remain valid through async prove jobs.
        const owned = std.heap.c_allocator.dupe(u8, bytes) catch {
            self.recordError(error.OutOfMemory);
            return;
        };
        defer std.heap.c_allocator.free(owned);
        lockBridgeResponse(&self.bridge_response_mutex);
        self.last_bridge_response_serial = 0;
        unlockBridgeResponse(&self.bridge_response_mutex);
        self.runtime.dispatchPlatformEvent(self.poker_app.runtimeApp(), .{
            .bridge_message = .{
                .bytes = owned,
                .origin = "zero://app",
                .window_id = 1,
                .webview_label = "main",
            },
        }) catch |err| self.recordError(err);
        const sync_response = self.null_platform.lastBridgeResponse();
        if (sync_response.len > 0) {
            self.storeBridgeResponse(sync_response);
        }
    }

    fn captureLoadedSource(self: *IosHostApp) void {
        const source = self.poker_app.runtimeApp().webViewSource() catch {
            self.loaded_source_kind = -1;
            return;
        };
        self.loaded_source_kind = switch (source.kind) {
            .html => 0,
            .url => 1,
            .assets => 2,
        };
        if (source.asset_options) |options| {
            const root_count = @min(options.root_path.len, max_asset_root_bytes);
            @memcpy(self.loaded_asset_root[0..root_count], options.root_path[0..root_count]);
            self.loaded_asset_root_len = root_count;
            const entry_count = @min(options.entry.len, max_asset_entry_bytes);
            @memcpy(self.loaded_asset_entry[0..entry_count], options.entry[0..entry_count]);
            self.loaded_asset_entry_len = entry_count;
        }
    }

    fn storeBridgeResponse(self: *IosHostApp, response: []const u8) void {
        lockBridgeResponse(&self.bridge_response_mutex);
        defer unlockBridgeResponse(&self.bridge_response_mutex);
        const count = @min(response.len, self.bridge_response.len);
        @memcpy(self.bridge_response[0..count], response[0..count]);
        self.bridge_response_len = count;
        self.bridge_response_serial +|= 1;
    }

    fn takeBridgeResponse(self: *IosHostApp, out: []u8) usize {
        lockBridgeResponse(&self.bridge_response_mutex);
        defer unlockBridgeResponse(&self.bridge_response_mutex);
        if (self.bridge_response_len == 0) return 0;
        if (self.bridge_response_serial == self.last_bridge_response_serial) return 0;
        self.last_bridge_response_serial = self.bridge_response_serial;
        const count = @min(self.bridge_response_len, out.len);
        @memcpy(out[0..count], self.bridge_response[0..count]);
        return count;
    }
};

fn hostApp(raw: ?*anyopaque) ?*IosHostApp {
    const pointer = raw orelse return null;
    return @ptrCast(@alignCast(pointer));
}

export fn zero_native_app_create() ?*anyopaque {
    const self = IosHostApp.create() catch return null;
    active_host_app = self;
    return self;
}

export fn ios_embed_set_bridge_response(response: [*]const u8, len: usize) void {
    const self = active_host_app orelse return;
    self.storeBridgeResponse(response[0..len]);
}

export fn zero_native_app_destroy(app: ?*anyopaque) void {
    const self = hostApp(app) orelse return;
    if (active_host_app == self) active_host_app = null;
    self.poker_app.deinit(std.heap.page_allocator);
    std.heap.page_allocator.destroy(self);
}

export fn zero_native_app_start(app: ?*anyopaque) void {
    const self = hostApp(app) orelse return;
    self.applyAssetConfig();
    self.runtime.dispatchPlatformEvent(self.poker_app.runtimeApp(), .app_start) catch |err| {
        self.recordError(err);
    };
    self.captureLoadedSource();
}

export fn zero_native_app_activate(app: ?*anyopaque) void {
    _ = app;
}

export fn zero_native_app_deactivate(app: ?*anyopaque) void {
    _ = app;
}

export fn zero_native_app_stop(app: ?*anyopaque) void {
    const self = hostApp(app) orelse return;
    self.runtime.dispatchPlatformEvent(self.poker_app.runtimeApp(), .app_shutdown) catch |err| {
        self.recordError(err);
    };
}

export fn zero_native_app_resize(app: ?*anyopaque, width: f32, height: f32, scale: f32, surface: ?*anyopaque) void {
    const self = hostApp(app) orelse return;
    self.runtime.dispatchPlatformEvent(self.poker_app.runtimeApp(), .{
        .surface_resized = .{
            .size = .{ .width = width, .height = height },
            .scale_factor = scale,
            .native_handle = surface,
        },
    }) catch |err| self.recordError(err);
}

export fn zero_native_app_touch(app: ?*anyopaque, id: u64, phase: c_int, x: f32, y: f32, pressure: f32) void {
    _ = app;
    _ = id;
    _ = phase;
    _ = x;
    _ = y;
    _ = pressure;
}

export fn zero_native_app_command(app: ?*anyopaque, name: ?[*]const u8, len: usize) void {
    const self = hostApp(app) orelse return;
    const ptr = name orelse {
        self.recordError(error.InvalidCommand);
        return;
    };
    if (len == 0) {
        self.recordError(error.InvalidCommand);
        return;
    }
    self.runtime.dispatchEvent(self.poker_app.runtimeApp(), .{
        .command = .{ .name = ptr[0..len] },
    }) catch |err| self.recordError(err);
}

export fn zero_native_app_frame(app: ?*anyopaque) void {
    const self = hostApp(app) orelse return;
    self.runtime.dispatchPlatformEvent(self.poker_app.runtimeApp(), .frame_requested) catch |err| {
        self.recordError(err);
    };
}

export fn zero_native_app_set_asset_root(app: ?*anyopaque, path: ?[*]const u8, len: usize) void {
    const self = hostApp(app) orelse return;
    const ptr = path orelse return;
    const count = @min(len, max_asset_root_bytes);
    @memcpy(self.asset_root[0..count], ptr[0..count]);
    self.asset_root_len = count;
}

export fn zero_native_app_set_zkey_root(app: ?*anyopaque, path: ?[*]const u8, len: usize) void {
    const self = hostApp(app) orelse return;
    const ptr = path orelse return;
    const count = @min(len, max_asset_root_bytes);
    @memcpy(self.zkey_root[0..count], ptr[0..count]);
    self.zkey_root_len = count;
}

export fn zero_native_app_set_asset_entry(app: ?*anyopaque, path: ?[*]const u8, len: usize) void {
    const self = hostApp(app) orelse return;
    const ptr = path orelse return;
    const count = @min(len, max_asset_entry_bytes);
    @memcpy(self.asset_entry[0..count], ptr[0..count]);
    self.asset_entry_len = count;
}

export fn zero_native_app_bridge_dispatch(app: ?*anyopaque, message: ?[*]const u8, len: usize) void {
    const self = hostApp(app) orelse return;
    const ptr = message orelse return;
    const count = @min(len, max_bridge_message_bytes);
    self.dispatchBridge(ptr[0..count]);
}

export fn zero_native_app_take_bridge_response(app: ?*anyopaque, out: ?[*]u8, capacity: usize) usize {
    const self = hostApp(app) orelse return 0;
    const buffer = out orelse return 0;
    if (capacity == 0) return 0;
    return self.takeBridgeResponse(buffer[0..capacity]);
}

export fn zero_native_app_loaded_source_kind(app: ?*anyopaque) c_int {
    const self = hostApp(app) orelse return -1;
    return self.loaded_source_kind;
}

export fn zero_native_app_loaded_asset_root(app: ?*anyopaque, out: ?[*]u8, capacity: usize) usize {
    const self = hostApp(app) orelse return 0;
    const buffer = out orelse return 0;
    const count = @min(self.loaded_asset_root_len, capacity);
    @memcpy(buffer[0..count], self.loaded_asset_root[0..count]);
    return count;
}

export fn zero_native_app_loaded_asset_entry(app: ?*anyopaque, out: ?[*]u8, capacity: usize) usize {
    const self = hostApp(app) orelse return 0;
    const buffer = out orelse return 0;
    const count = @min(self.loaded_asset_entry_len, capacity);
    @memcpy(buffer[0..count], self.loaded_asset_entry[0..count]);
    return count;
}

export fn zero_native_app_last_command_count(app: ?*anyopaque) usize {
    const self = hostApp(app) orelse return 0;
    return self.runtime.frameDiagnostics().command_count;
}

export fn zero_native_app_last_command_name(app: ?*anyopaque) [*:0]const u8 {
    _ = app;
    return "";
}

export fn zero_native_app_last_error_name(app: ?*anyopaque) [*:0]const u8 {
    const self = hostApp(app) orelse return "";
    const err = self.last_error orelse return "";
    return @errorName(err);
}
