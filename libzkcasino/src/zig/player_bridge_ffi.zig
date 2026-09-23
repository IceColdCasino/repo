//! Host C ABI for the same JSON player ops as the native `player` command.
//! Per-handle key/crypto; process-wide Groth16 engine (zkeys loaded once).
//! Poker uses `bridge_ops`. Other table games use `game_bridge`.
const std = @import("std");
const ops = @import("player/bridge_ops.zig");
const game_bridge = @import("player/game_bridge.zig");
const prove = @import("prove.zig");

const Handle = struct {
    kind: game_bridge.Kind,
    poker: ops.State,
    table: ?game_bridge.Session,
};

var engine_lock: std.atomic.Mutex = .unlocked;
var engine: ?prove.Engine = null;
var engine_err: bool = false;

fn lockEngine() void {
    while (!engine_lock.tryLock()) {
        std.Thread.yield() catch {};
    }
}

fn ensureEngine() !*prove.Engine {
    lockEngine();
    defer engine_lock.unlock();
    if (engine == null) {
        if (engine_err) return error.EngineUnavailable;
        engine = prove.Engine.init(std.heap.page_allocator) catch |err| {
            engine_err = true;
            return err;
        };
    }
    return &engine.?;
}

fn circuitId(name: []const u8) !prove.CircuitId {
    if (std.mem.eql(u8, name, ops.REGISTER_CIRCUIT)) return .register_main;
    if (std.mem.eql(u8, name, ops.SHUFFLE_CIRCUIT)) return .shuffle_1_deck_52_main;
    if (std.mem.eql(u8, name, ops.SHARE_CIRCUIT)) return .poker_share_hashout_main;
    if (std.mem.eql(u8, name, ops.SHOWDOWN_CIRCUIT)) return .poker_showdown_hashout_main;
    return error.UnknownCircuit;
}

const HeldProof = struct {
    proof: prove.Proof,
};

fn proveCb(ctx: *anyopaque, circuit: []const u8, input: []const u8) anyerror!ops.ProveOutput {
    _ = ctx;
    const id = try circuitId(circuit);
    lockEngine();
    defer engine_lock.unlock();
    if (engine == null) {
        if (engine_err) return error.EngineUnavailable;
        engine = prove.Engine.init(std.heap.page_allocator) catch |err| {
            engine_err = true;
            return err;
        };
    }
    const proof = try engine.?.proveJson(id, input);
    const held = std.heap.page_allocator.create(HeldProof) catch {
        var tmp = proof;
        tmp.deinit();
        return error.OutOfMemory;
    };
    held.* = .{ .proof = proof };
    return .{
        .proof = held.proof.proof_json,
        .public_signals = held.proof.public_json,
        .cookie = held,
    };
}

fn freeCb(ctx: *anyopaque, out: ops.ProveOutput) void {
    _ = ctx;
    const held: *HeldProof = @ptrCast(@alignCast(out.cookie orelse return));
    held.proof.deinit();
    std.heap.page_allocator.destroy(held);
}

fn backend() ops.Backend {
    return .{
        .ctx = undefined,
        .prove = proveCb,
        .free = freeCb,
    };
}

fn kindFromU32(kind: u32) !game_bridge.Kind {
    return switch (kind) {
        0 => .poker,
        1 => .baccarat,
        2 => .blackjack,
        3 => .war,
        4 => .roulette,
        5 => .craps,
        6 => .keno,
        7 => .slots,
        8 => .bingo,
        else => error.InvalidGameKind,
    };
}

export fn zkplayer_bridge_create() callconv(.c) ?*Handle {
    return zkplayer_bridge_create_ex(0, 0);
}

export fn zkplayer_bridge_create_ex(kind_u: u32, variant: u32) callconv(.c) ?*Handle {
    const alloc = std.heap.page_allocator;
    const kind = kindFromU32(kind_u) catch return null;
    const h = alloc.create(Handle) catch return null;
    if (kind == .poker) {
        h.* = .{ .kind = .poker, .poker = .init(alloc), .table = null };
        return h;
    }
    const eng = ensureEngine() catch {
        alloc.destroy(h);
        return null;
    };
    const session = game_bridge.Session.init(alloc, eng, kind, variant) catch {
        alloc.destroy(h);
        return null;
    };
    h.* = .{ .kind = kind, .poker = .init(alloc), .table = session };
    return h;
}

export fn zkplayer_bridge_free(handle: ?*Handle) callconv(.c) void {
    const h = handle orelse return;
    if (h.table) |*s| s.deinit();
    h.poker.deinit();
    std.heap.page_allocator.destroy(h);
}

export fn zkplayer_bridge_op(
    handle: ?*Handle,
    payload: [*]const u8,
    payload_len: usize,
    out: [*]u8,
    out_cap: usize,
    out_len: *usize,
) callconv(.c) i32 {
    const h = handle orelse return -1;
    const body = if (h.table) |*session| blk: {
        lockEngine();
        defer engine_lock.unlock();
        break :blk game_bridge.dispatch(session, payload[0..payload_len]) catch return -2;
    } else ops.dispatch(&h.poker, payload[0..payload_len], backend()) catch return -2;
    defer std.heap.page_allocator.free(body);
    if (body.len > out_cap) return -3;
    @memcpy(out[0..body.len], body);
    out_len.* = body.len;
    return 0;
}
