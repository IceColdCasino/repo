const std = @import("std");
const zero_native = @import("zero-native");

pub const State = struct {
    env_map: ?*std.process.Environ.Map,
};

pub fn launchConfigHandler(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *State = @ptrCast(@alignCast(context));
    const env_map = self.env_map orelse {
        return std.fmt.bufPrint(output, "{{\"manualSetup\":false}}", .{});
    };

    const manual = env_map.get("ZK_LAUNCH_MANUAL_SETUP") orelse env_map.get("ZK_MANUAL_SETUP");
    const seat_str = env_map.get("ZK_LAUNCH_SEAT") orelse env_map.get("ZK_MANUAL_SEAT");
    const wallet = env_map.get("ZK_LAUNCH_NEW_WALLET") orelse env_map.get("ZK_MANUAL_WALLET");
    const start_hand = env_map.get("ZK_LAUNCH_START_HAND") orelse env_map.get("ZK_MANUAL_START_HAND");
    const auto_play = env_map.get("ZK_LAUNCH_AUTO_PLAY") orelse env_map.get("ZK_MANUAL_AUTO_PLAY");
    const backend = env_map.get("ZK_LAUNCH_BACKEND") orelse env_map.get("ZK_BACKEND");
    const api_base = env_map.get("ZK_LAUNCH_API_BASE")
        orelse env_map.get("ZK_LAUNCH_CHAIN_WORKER")
        orelse env_map.get("ZK_API_BASE");
    const solana_rpc = env_map.get("ZK_LAUNCH_SOLANA_RPC") orelse env_map.get("SOLANA_RPC_URL");
    const offset_raw = env_map.get("ARCIUM_CLUSTER_OFFSET") orelse env_map.get("ZK_LAUNCH_CLUSTER_OFFSET");

    const manual_setup = manual != null and (std.mem.eql(u8, manual.?, "1") or std.ascii.eqlIgnoreCase(manual.?, "true"));
    const seat: i32 = if (seat_str) |s| std.fmt.parseInt(i32, s, 10) catch -1 else -1;
    const new_wallet = wallet != null and (std.mem.eql(u8, wallet.?, "1") or std.ascii.eqlIgnoreCase(wallet.?, "new") or std.ascii.eqlIgnoreCase(wallet.?, "true"));
    const start_hand_flag = start_hand != null and (std.mem.eql(u8, start_hand.?, "1") or std.ascii.eqlIgnoreCase(start_hand.?, "true"));
    const auto_play_flag = if (auto_play) |value|
        std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true")
    else
        false;

    var rpc_json_buf: [640]u8 = undefined;
    const rpc_json: []const u8 = if (solana_rpc) |value| blk: {
        if (value.len == 0 or value.len > 480) break :blk "";
        var escaped: [512]u8 = undefined;
        const url = escapeJsString(value, &escaped) orelse break :blk "";
        break :blk std.fmt.bufPrint(&rpc_json_buf, ",\"solanaRpc\":\"{s}\"", .{url}) catch "";
    } else "";
    const loopback = if (solana_rpc) |value|
        std.mem.indexOf(u8, value, "127.0.0.1") != null or std.mem.indexOf(u8, value, "localhost") != null
    else
        true;
    const offset: i64 = if (offset_raw) |value|
        std.fmt.parseInt(i64, value, 10) catch if (loopback) 0 else 456
    else if (loopback) 0 else 456;
    var offset_json_buf: [48]u8 = undefined;
    const offset_json = if (solana_rpc != null)
        std.fmt.bufPrint(&offset_json_buf, ",\"clusterOffset\":{d}", .{offset}) catch ""
    else
        "";

    if (!manual_setup or seat < 0 or seat > 9) {
        return std.fmt.bufPrint(output, "{{\"manualSetup\":false{s}{s}}}", .{ rpc_json, offset_json });
    }

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
    const api_json: []const u8 = if (api_base) |value| blk: {
        if (backend != null and std.ascii.eqlIgnoreCase(backend.?, "solana")) {
            break :blk std.fmt.bufPrint(
                &api_json_buf,
                ",\"apiBase\":\"{s}\",\"chainWorker\":\"{s}\"",
                .{ value, value },
            ) catch "";
        }
        break :blk std.fmt.bufPrint(&api_json_buf, ",\"apiBase\":\"{s}\"", .{value}) catch "";
    } else "";

    return std.fmt.bufPrint(output, "{{\"manualSetup\":true,\"seat\":{d},\"newWallet\":{s},\"startHand\":{s},\"autoPlay\":{s}{s}{s}{s}{s}}}", .{
        seat,
        if (new_wallet) "true" else "false",
        if (start_hand_flag) "true" else "false",
        if (auto_play_flag) "true" else "false",
        backend_json,
        api_json,
        rpc_json,
        offset_json,
    });
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

const bridge_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5178",
};

pub fn bridgePolicy() [1]zero_native.BridgeCommandPolicy {
    return .{
        .{ .name = "app.launchConfig", .origins = &bridge_origins },
    };
}

pub fn registerHandlers(state: *State, handlers: *[1]zero_native.BridgeHandler) void {
    handlers.* = .{
        .{ .name = "app.launchConfig", .context = state, .invoke_fn = launchConfigHandler },
    };
}
