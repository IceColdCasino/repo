const std = @import("std");
const zero_native = @import("zero-native");
const zk_bridge = @import("zk_bridge");
const player_bridge = @import("player_bridge");
const server_bridge = @import("server_bridge");
const launch_config_bridge = @import("launch_config_bridge");
const solana_bridge = @import("solana_bridge");

const key_clib = struct {
    pub extern "c" fn fopen(filename: [*:0]const u8, mode: [*:0]const u8) ?*anyopaque;
    pub extern "c" fn fclose(stream: ?*anyopaque) c_int;
    pub extern "c" fn fread(ptr: [*]u8, size: usize, count: usize, stream: ?*anyopaque) usize;
};

fn readJsonKeyArray(path: []const u8, out: []u8) ?[]const u8 {
    if (path.len == 0 or path.len >= 1024 or out.len < 8) return null;
    var zpath: [1025]u8 = undefined;
    @memcpy(zpath[0..path.len], path);
    zpath[path.len] = 0;
    const file = key_clib.fopen(zpath[0..path.len :0].ptr, "rb") orelse return null;
    defer _ = key_clib.fclose(file);
    const n = key_clib.fread(out.ptr, 1, out.len - 1, file);
    if (n == 0 or n >= out.len - 1) return null;
    var start: usize = 0;
    while (start < n and (out[start] == ' ' or out[start] == '\n' or out[start] == '\r' or out[start] == '\t')) : (start += 1) {}
    var end = n;
    while (end > start and (out[end - 1] == ' ' or out[end - 1] == '\n' or out[end - 1] == '\r' or out[end - 1] == '\t')) : (end -= 1) {}
    if (end <= start or out[start] != '[' or out[end - 1] != ']') return null;
    for (out[start..end]) |byte| {
        const ok = byte == '[' or byte == ']' or byte == ',' or byte == ' '
            or byte == '\n' or byte == '\r' or byte == '\t'
            or (byte >= '0' and byte <= '9');
        if (!ok) return null;
    }
    return out[start..end];
}

fn escapeJsString(input: []const u8, out: []u8) ?[]const u8 {
    var o: usize = 0;
    for (input) |byte| {
        if (byte == '"' or byte == '\\') {
            if (o + 2 > out.len) return null;
            out[o] = '\\';
            o += 1;
            out[o] = byte;
            o += 1;
        } else if (byte < 0x20) {
            return null;
        } else {
            if (o + 1 > out.len) return null;
            out[o] = byte;
            o += 1;
        }
    }
    return out[0..o];
}

pub const bridge_sync_handler_count = zk_bridge.zk_sync_handler_count + player_bridge.sync_handler_count + 4 + 1 + 2;
pub const bridge_async_handler_count = zk_bridge.zk_async_handler_count + player_bridge.async_handler_count;
pub const bridge_policy_count = 12;

pub const App = struct {
    env_map: ?*std.process.Environ.Map,
    io: ?std.Io,
    asset_root: []const u8 = "",
    asset_entry: []const u8 = "index.html",
    asset_entry_buf: [512]u8 = undefined,
    zk_state: zk_bridge.State,
    player_state: player_bridge.State,
    server_state: server_bridge.State,
    launch_config_state: launch_config_bridge.State,
    solana_state: solana_bridge.State,
    bridge_handlers: [bridge_sync_handler_count]zero_native.BridgeHandler = undefined,
    bridge_async_handlers: [bridge_async_handler_count]zero_native.bridge.AsyncHandler = undefined,
    bridge_policies: [bridge_policy_count]zero_native.BridgeCommandPolicy = undefined,

    pub fn initEmbedded(alloc: std.mem.Allocator) !App {
        var state: App = .{
            .env_map = null,
            .io = null,
            .zk_state = try zk_bridge.State.initEmbedded(alloc),
            .player_state = player_bridge.State.initEmbedded(alloc),
            .server_state = try server_bridge.State.initEmbedded(alloc),
            .launch_config_state = .{ .env_map = null },
            .solana_state = try solana_bridge.State.initEmbedded(alloc),
        };
        state.initBridgePolicies();
        return state;
    }

    pub fn initDesktop(io: std.Io, env_map: *std.process.Environ.Map) !App {
        var state: App = .{
            .env_map = env_map,
            .io = io,
            .zk_state = try zk_bridge.State.init(env_map, std.heap.page_allocator),
            .player_state = player_bridge.State.init(std.heap.page_allocator),
            .server_state = try server_bridge.State.init(io, env_map, std.heap.page_allocator),
            .launch_config_state = .{ .env_map = env_map },
            .solana_state = try solana_bridge.State.init(io, env_map, std.heap.page_allocator),
        };
        state.writeChainLaunchConfig();
        state.applyLaunchConfigFromEnv();
        state.initBridgePolicies();
        return state;
    }

    /// Point the WebView at SOLANA_RPC_URL when launch-config.js has not already chosen an RPC.
    fn writeChainLaunchConfig(self: *App) void {
        const env_map = self.env_map orelse return;
        const io = self.io orelse return;
        const rpc = env_map.get("ZK_LAUNCH_SOLANA_RPC") orelse env_map.get("SOLANA_RPC_URL") orelse return;
        if (rpc.len == 0 or rpc.len > 480) return;
        const offset_raw = env_map.get("ARCIUM_CLUSTER_OFFSET") orelse env_map.get("ZK_LAUNCH_CLUSTER_OFFSET");
        const loopback = std.mem.indexOf(u8, rpc, "127.0.0.1") != null or std.mem.indexOf(u8, rpc, "localhost") != null;
        const offset: i64 = if (offset_raw) |value|
            std.fmt.parseInt(i64, value, 10) catch if (loopback) 0 else 456
        else if (loopback) 0 else 456;

        const home = env_map.get("HOME") orelse "";
        var admin_path_buf: [512]u8 = undefined;
        var payer_path_buf: [512]u8 = undefined;
        const admin_path = env_map.get("WHITELIST_ADMIN_KEYPAIR") orelse std.fmt.bufPrint(
            &admin_path_buf,
            "{s}/.config/solana/whitelist-admin.json",
            .{home},
        ) catch "";
        const payer_path = env_map.get("MXE_AUTHORITY_KEYPAIR") orelse std.fmt.bufPrint(
            &payer_path_buf,
            "{s}/.config/solana/id.json",
            .{home},
        ) catch "";
        var admin_key_buf: [768]u8 = undefined;
        var payer_key_buf: [768]u8 = undefined;
        const admin_key = readJsonKeyArray(admin_path, &admin_key_buf);
        const payer_key = readJsonKeyArray(payer_path, &payer_key_buf);
        var admin_field_buf: [800]u8 = undefined;
        var payer_field_buf: [800]u8 = undefined;
        const admin_field: []const u8 = if (admin_key) |key|
            std.fmt.bufPrint(&admin_field_buf, ", whitelistAdminSecret: {s}", .{key}) catch ""
        else
            "";
        const payer_field: []const u8 = if (payer_key) |key|
            std.fmt.bufPrint(&payer_field_buf, ", feePayerSecret: {s}", .{key}) catch ""
        else
            "";

        const paths = [_][]const u8{
            "frontend/dist/launch-config.js",
        };
        for (paths) |sub_path| {
            var existing_buf: [8192]u8 = undefined;
            const existing = std.Io.Dir.readFile(.cwd(), io, sub_path, &existing_buf) catch "";
            if (std.mem.indexOf(u8, existing, "solanaRpc") != null) continue;
            var url_buf: [512]u8 = undefined;
            const url = escapeJsString(rpc, &url_buf) orelse continue;
            var out_buf: [4096]u8 = undefined;
            const body = std.fmt.bufPrint(
                &out_buf,
                "window.__ZK_LAUNCH_CONFIG = {{ manualSetup: false, backend: \"{s}\", clusterOffset: {d}, solanaRpc: \"{s}\"{s}{s} }};\n",
                .{ if (loopback) "solana" else "devnet", offset, url, admin_field, payer_field },
            ) catch continue;
            std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = sub_path, .data = body }) catch |err| {
                std.log.warn("chain launch-config write failed err={s}", .{@errorName(err)});
            };
        }
    }

    /// Per-seat HTML entry with inline launch config (zero:// ignores query strings; shared launch-config.js races).
    fn applyLaunchConfigFromEnv(self: *App) void {
        const env_map = self.env_map orelse return;
        const io = self.io orelse return;
        const manual = env_map.get("ZK_LAUNCH_MANUAL_SETUP") orelse env_map.get("ZK_MANUAL_SETUP");
        const seat_str = env_map.get("ZK_LAUNCH_SEAT") orelse env_map.get("ZK_MANUAL_SEAT");
        const wallet = env_map.get("ZK_LAUNCH_NEW_WALLET") orelse env_map.get("ZK_MANUAL_WALLET");
        const start_hand = env_map.get("ZK_LAUNCH_START_HAND") orelse env_map.get("ZK_MANUAL_START_HAND");
        const auto_play = env_map.get("ZK_LAUNCH_AUTO_PLAY") orelse env_map.get("ZK_MANUAL_AUTO_PLAY");
        const backend = env_map.get("ZK_LAUNCH_BACKEND") orelse env_map.get("ZK_BACKEND");
        const api_base = env_map.get("ZK_LAUNCH_API_BASE")
            orelse env_map.get("ZK_LAUNCH_CHAIN_WORKER")
            orelse env_map.get("ZK_API_BASE");

        const manual_setup = if (manual) |value|
            std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true")
        else
            false;
        if (!manual_setup) return;

        const seat: i32 = if (seat_str) |value| std.fmt.parseInt(i32, value, 10) catch -1 else -1;
        if (seat < 0 or seat > 9) return;

        const new_wallet = wallet != null and (std.mem.eql(u8, wallet.?, "1") or std.ascii.eqlIgnoreCase(wallet.?, "new") or std.ascii.eqlIgnoreCase(wallet.?, "true"));
        const start_hand_flag = start_hand != null and (std.mem.eql(u8, start_hand.?, "1") or std.ascii.eqlIgnoreCase(start_hand.?, "true"));
        const auto_play_flag = if (auto_play) |value|
            std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true")
        else
            true;

        const backend_json: []const u8 = if (backend) |value|
            if (std.ascii.eqlIgnoreCase(value, "solana"))
                ",\"backend\":\"solana\""
            else if (std.ascii.eqlIgnoreCase(value, "local"))
                ",\"backend\":\"local\""
            else
                ""
        else
            "";

        var api_json_buf: [320]u8 = undefined;
        const api_json: []const u8 = if (api_base) |value|
            std.fmt.bufPrint(&api_json_buf, ",\"apiBase\":\"{s}\"", .{value}) catch ""
        else
            "";

        // Merge seat/bootstrap fields into launch-config.js (keeps whitelistAdminSecret,
        // solanaRpc, etc.). Do NOT replace launch-config.js or invent chainWorker —
        // in-WebView executePerSeatOp is the default Solana path (noChainWorker=1).
        var inline_buf: [1024]u8 = undefined;
        const inline_script = std.fmt.bufPrint(&inline_buf, "<script>(function(){{var b=window.__ZK_LAUNCH_CONFIG||{{}};window.__ZK_LAUNCH_CONFIG=Object.assign({{}},b,{{\"manualSetup\":true,\"seat\":{d},\"newWallet\":{s},\"startHand\":{s},\"autoPlay\":{s}{s}{s}}});}})();</script>", .{
            seat,
            if (new_wallet) "true" else "false",
            if (start_hand_flag) "true" else "false",
            if (auto_play_flag) "true" else "false",
            backend_json,
            api_json,
        }) catch return;

        const dist_paths = [_][]const u8{ "frontend/dist/index.html" };
        for (dist_paths) |dist_index| {
            self.writeSeatLaunchHtml(io, dist_index, seat, inline_script) catch |err| {
                std.log.warn("launch html write failed seat={d} err={s}", .{ seat, @errorName(err) });
            };
        }

        self.asset_entry = std.fmt.bufPrint(&self.asset_entry_buf, "index-seat-{d}.html", .{seat}) catch return;
        std.log.info("launch entry seat={d} path={s}", .{ seat, self.asset_entry });
    }

    fn writeSeatLaunchHtml(
        self: *App,
        io: std.Io,
        index_path: []const u8,
        seat: i32,
        inline_script: []const u8,
    ) !void {
        _ = self;
        var html_buf: [65536]u8 = undefined;
        const html = try std.Io.Dir.readFile(.cwd(), io, index_path, &html_buf);

        // Keep launch-config.js (admin secret / RPC), then merge seat bootstrap fields.
        const needle = "<script src=\"./launch-config.js\"></script>";
        var out_buf: [65536]u8 = undefined;
        var strip_buf: [65536]u8 = undefined;
        const patched = if (std.mem.indexOf(u8, html, needle)) |idx| blk: {
            const prefix = html[0 .. idx + needle.len];
            const suffix = html[idx + needle.len ..];
            break :blk try std.fmt.bufPrint(&out_buf, "{s}\n    {s}{s}", .{ prefix, inline_script, suffix });
        } else blk: {
            break :blk try std.fmt.bufPrint(&out_buf, "{s}{s}", .{ inline_script, html });
        };
        const stripped = stripHtmlCrossOrigin(patched, &strip_buf);

        var out_path_buf: [128]u8 = undefined;
        const out_path = try std.fmt.bufPrint(&out_path_buf, "frontend/dist/index-seat-{d}.html", .{seat});
        try std.Io.Dir.writeFile(.cwd(), io, .{ .sub_path = out_path, .data = stripped });
        std.log.info("launch html written seat={d} path={s} bytes={d}", .{ seat, out_path, stripped.len });
    }

    fn stripHtmlCrossOrigin(html: []const u8, out: []u8) []const u8 {
        var in: usize = 0;
        var o: usize = 0;
        while (in < html.len) {
            if (std.mem.startsWith(u8, html[in..], " crossorigin")) {
                in += " crossorigin".len;
                if (in < html.len and html[in] == '=') {
                    in += 1;
                    if (in < html.len and html[in] == '"') {
                        in += 1;
                        while (in < html.len and html[in] != '"') : (in += 1) {}
                        if (in < html.len) in += 1;
                    }
                }
                continue;
            }
            if (o >= out.len) return html;
            out[o] = html[in];
            o += 1;
            in += 1;
        }
        return out[0..o];
    }

    pub fn setAssetRoot(self: *App, path: []const u8) void {
        self.asset_root = path;
        self.zk_state.setResourceRoot(path);
    }

    pub fn setZkeyRoot(self: *App, path: []const u8) void {
        self.zk_state.setZkeyRoot(path);
    }

    pub fn setAssetEntry(self: *App, entry: []const u8) void {
        self.asset_entry = entry;
    }

    fn initBridgePolicies(self: *App) void {
        const zk_policies = zk_bridge.bridgePolicy();
        const player_policies = player_bridge.bridgePolicy();
        const server_policies = server_bridge.bridgePolicy();
        const launch_policies = launch_config_bridge.bridgePolicy();
        const solana_policies = solana_bridge.bridgePolicy();
        inline for (zk_policies, 0..) |policy, i| {
            self.bridge_policies[i] = policy;
        }
        self.bridge_policies[zk_policies.len] = player_policies[0];
        self.bridge_policies[zk_policies.len + 1] = server_policies[0];
        self.bridge_policies[zk_policies.len + 2] = server_policies[1];
        self.bridge_policies[zk_policies.len + 3] = server_policies[2];
        self.bridge_policies[zk_policies.len + 4] = server_policies[3];
        inline for (launch_policies, 0..) |policy, i| {
            self.bridge_policies[zk_policies.len + 5 + i] = policy;
        }
        self.bridge_policies[zk_policies.len + 5 + launch_policies.len] = solana_policies[0];
        self.bridge_policies[zk_policies.len + 5 + launch_policies.len + 1] = solana_policies[1];
    }

    pub fn deinit(self: *App, alloc: std.mem.Allocator) void {
        self.zk_state.deinit(alloc);
        self.player_state.deinit();
        self.server_state.deinit(alloc);
        self.solana_state.deinit(alloc);
    }

    pub fn runtimeApp(self: *App) zero_native.App {
        return .{
            .context = self,
            .name = "app",
            .source = zero_native.frontend.productionSource(.{
                .dist = "frontend/dist",
                .entry = self.asset_entry,
            }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *App = @ptrCast(@alignCast(context));
        if (self.asset_root.len > 0) {
            var dist_buf: [4096]u8 = undefined;
            const dist_path = std.fmt.bufPrint(&dist_buf, "{s}/frontend/dist", .{self.asset_root}) catch self.asset_root;
            return zero_native.WebViewSource.assets(.{
                .root_path = dist_path,
                .entry = self.asset_entry,
                .origin = "zero://app",
                .spa_fallback = true,
            });
        }
        if (self.env_map) |env_map| {
            return zero_native.frontend.sourceFromEnv(env_map, .{
                .dist = "frontend/dist",
                .entry = self.asset_entry,
            });
        }
        return zero_native.frontend.productionSource(.{
            .dist = "frontend/dist",
            .entry = self.asset_entry,
        });
    }

    pub fn bridge(self: *App) zero_native.BridgeDispatcher {
        self.player_state.bindZk(&self.zk_state);
        var zk_sync_handlers: [zk_bridge.zk_sync_handler_count]zero_native.BridgeHandler = undefined;
        var zk_async_handlers: [zk_bridge.zk_async_handler_count]zero_native.bridge.AsyncHandler = undefined;
        var player_sync_handlers: [player_bridge.sync_handler_count]zero_native.BridgeHandler = undefined;
        var player_async_handlers: [player_bridge.async_handler_count]zero_native.bridge.AsyncHandler = undefined;
        var server_handlers: [4]zero_native.BridgeHandler = undefined;
        var launch_handlers: [1]zero_native.BridgeHandler = undefined;
        var solana_handlers: [2]zero_native.BridgeHandler = undefined;
        zk_bridge.registerHandlers(&self.zk_state, &zk_sync_handlers);
        zk_bridge.registerAsyncHandlers(&self.zk_state, &zk_async_handlers);
        player_bridge.registerHandlers(&self.player_state, &player_sync_handlers);
        player_bridge.registerAsyncHandlers(&self.player_state, &player_async_handlers);
        server_bridge.registerHandlers(&self.server_state, &server_handlers);
        launch_config_bridge.registerHandlers(&self.launch_config_state, &launch_handlers);
        solana_bridge.registerHandlers(&self.solana_state, &solana_handlers);
        inline for (zk_sync_handlers, 0..) |handler, i| {
            self.bridge_handlers[i] = handler;
        }
        const player_sync_off = player_bridge.sync_handler_count;
        if (comptime player_sync_off > 0) {
            self.bridge_handlers[zk_bridge.zk_sync_handler_count] = player_sync_handlers[0];
        }
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off] = server_handlers[0];
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off + 1] = server_handlers[1];
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off + 2] = server_handlers[2];
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off + 3] = server_handlers[3];
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off + 4] = launch_handlers[0];
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off + 5] = solana_handlers[0];
        self.bridge_handlers[zk_bridge.zk_sync_handler_count + player_sync_off + 6] = solana_handlers[1];
        inline for (zk_async_handlers, 0..) |handler, i| {
            self.bridge_async_handlers[i] = handler;
        }
        if (comptime player_bridge.async_handler_count > 0) {
            self.bridge_async_handlers[zk_bridge.zk_async_handler_count] = player_async_handlers[0];
        }
        return .{
            .policy = .{ .enabled = true, .commands = &self.bridge_policies },
            .registry = .{ .handlers = &self.bridge_handlers },
            .async_registry = .{ .handlers = &self.bridge_async_handlers },
        };
    }
};

pub const dev_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5178",
};

pub const ios_origins = [_][]const u8{ "zero://app", "zero://inline" };
