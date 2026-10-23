//! Native poker player: keygen, decrypt, and Groth16 prove.
//! WebView calls one command: `player` `{ op, ... }`.
const std = @import("std");
const build_options = @import("build_options");
const zero_native = @import("zero-native");
const zk_bridge = @import("zk_bridge");
const main_thread = @import("main_thread_dispatch");
const player_crypto = @import("player_crypto");
const ops = player_crypto.bridge_ops;

const is_ios = build_options.is_ios;
const worker_stack_size: usize = 64 * 1024 * 1024;

// Shuffle / share / showdown Groth16 must not run on the AppKit main thread
// (8MB stack plus a synchronous bridge completion deadlocks the WebView).
pub const sync_handler_count = 0;
pub const async_handler_count = 1;

extern fn ios_embed_set_bridge_response(response: [*]const u8, len: usize) void;

pub const State = struct {
    alloc: std.mem.Allocator,
    lock: std.atomic.Mutex = .unlocked,
    ops: ops.State,
    zk: ?*zk_bridge.State = null,

    pub fn init(alloc: std.mem.Allocator) State {
        return .{ .alloc = alloc, .ops = .init(alloc) };
    }

    pub fn initEmbedded(alloc: std.mem.Allocator) State {
        return .{ .alloc = alloc, .ops = .init(alloc) };
    }

    pub fn bindZk(self: *State, zk: *zk_bridge.State) void {
        self.zk = zk;
    }

    pub fn deinit(self: *State) void {
        self.ops.deinit();
        self.zk = null;
    }
};

const bridge_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5178",
};

pub fn bridgePolicy() [1]zero_native.BridgeCommandPolicy {
    return .{
        .{ .name = "player", .origins = &bridge_origins },
    };
}

pub fn registerHandlers(state: *State, handlers: *[sync_handler_count]zero_native.BridgeHandler) void {
    if (comptime sync_handler_count == 0) return;
    handlers.* = .{
        .{ .name = "player", .context = state, .invoke_fn = handleOpSync },
    };
}

pub fn registerAsyncHandlers(state: *State, handlers: *[async_handler_count]zero_native.bridge.AsyncHandler) void {
    if (comptime async_handler_count == 0) return;
    handlers.* = .{
        .{ .name = "player", .context = state, .invoke_fn = handleOpAsync },
    };
}

pub fn handleOpSync(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    if (is_ios) return error.UnsupportedOperation;
    const self: *State = @ptrCast(@alignCast(context));
    lockState(self);
    defer self.lock.unlock();
    return dispatch(self, invocation.request.payload, output);
}

pub fn handleOpAsync(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
    const self: *State = @ptrCast(@alignCast(context));
    const job = try self.alloc.create(PlayerJob);
    errdefer self.alloc.destroy(job);
    job.* = .{
        .state = self,
        .payload = try self.alloc.dupe(u8, invocation.request.payload),
        .request_id = try self.alloc.dupe(u8, invocation.request.id),
        .responder = responder,
    };
    const thread = try std.Thread.spawn(.{ .stack_size = worker_stack_size }, PlayerJob.worker, .{job});
    thread.detach();
}

const PlayerJob = struct {
    state: *State,
    payload: []u8,
    request_id: []const u8,
    responder: zero_native.bridge.AsyncResponder,

    fn worker(job: *PlayerJob) void {
        const alloc = job.state.alloc;
        const payload = job.payload;
        const request_id = job.request_id;
        const state = job.state;
        const responder = job.responder;
        // Defers run in reverse order. Destroy the job last so these slices
        // stay valid; freeing the job first and then reading its fields segfaults.
        defer alloc.destroy(job);
        defer alloc.free(payload);
        defer alloc.free(request_id);
        std.debug.print("[player] async bytes={d}\n", .{payload.len});

        // Hold the player lock only while dispatch runs. Unlock before the
        // bridge completion so a main-thread callback can start the next
        // player op (decrypt, calc) without waiting out this call.
        lockState(state);
        const output = alloc.alloc(u8, zero_native.bridge.max_result_bytes) catch {
            state.lock.unlock();
            deliverFail(alloc, responder, request_id, "OutOfMemory");
            return;
        };
        const result = dispatch(state, payload, output) catch |err| {
            alloc.free(output);
            state.lock.unlock();
            deliverFail(alloc, responder, request_id, @errorName(err));
            return;
        };
        const owned = alloc.dupe(u8, result) catch {
            alloc.free(output);
            state.lock.unlock();
            deliverFail(alloc, responder, request_id, "OutOfMemory");
            return;
        };
        alloc.free(output);
        state.lock.unlock();
        deliverSuccess(alloc, responder, request_id, owned);
        alloc.free(owned);
    }
};

fn lockState(self: *State) void {
    while (!self.lock.tryLock()) {
        std.Thread.yield() catch {};
    }
}

fn dispatch(self: *State, payload: []const u8, output: []u8) ![]const u8 {
    const body = try ops.dispatch(&self.ops, payload, .{
        .ctx = self,
        .prove = proveCb,
        .free = freeCb,
    });
    defer self.alloc.free(body);
    if (body.len > output.len) return error.BufferTooSmall;
    @memcpy(output[0..body.len], body);
    return output[0..body.len];
}

fn proveCb(ctx: *anyopaque, circuit: []const u8, input: []const u8) anyerror!ops.ProveOutput {
    const self: *State = @ptrCast(@alignCast(ctx));
    const zk = self.zk orelse return error.ZkBridgeUnbound;
    std.debug.print("[player] prove {s} json={d}\n", .{ circuit, input.len });
    // Drop below the AppKit main thread for witness + Groth16. Child threads
    // spawned by the witness calculator and rapidsnark inherit this QoS.
    main_thread.setBackgroundComputeQos();
    defer main_thread.setUserInitiatedQos();
    const out = try zk.proveCircuit(circuit, input);
    return .{ .proof = out.proof, .public_signals = out.public_signals };
}

fn freeCb(ctx: *anyopaque, out: ops.ProveOutput) void {
    const self: *State = @ptrCast(@alignCast(ctx));
    const zk = self.zk orelse return;
    zk.allocator().free(out.proof);
    zk.allocator().free(out.public_signals);
}

fn deliverSuccess(
    allocator: std.mem.Allocator,
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    body: []const u8,
) void {
    const response_buffer = allocator.alloc(u8, zero_native.bridge.max_response_bytes) catch {
        responder.fail(request_id, .handler_failed, "OutOfMemory") catch {};
        return;
    };
    defer allocator.free(response_buffer);
    const full = zero_native.bridge.writeSuccessResponse(response_buffer, request_id, body);
    if (is_ios) {
        ios_embed_set_bridge_response(full.ptr, full.len);
    }
    responder.respond(full) catch {};
}

fn deliverFail(
    allocator: std.mem.Allocator,
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    message: []const u8,
) void {
    const response_buffer = allocator.alloc(u8, zero_native.bridge.max_response_bytes) catch {
        responder.fail(request_id, .handler_failed, message) catch {};
        return;
    };
    defer allocator.free(response_buffer);
    const full = zero_native.bridge.writeErrorResponse(response_buffer, request_id, .handler_failed, message);
    if (is_ios) {
        ios_embed_set_bridge_response(full.ptr, full.len);
    }
    responder.respond(full) catch {};
}
