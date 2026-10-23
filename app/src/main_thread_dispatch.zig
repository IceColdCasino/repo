const std = @import("std");
const builtin = @import("builtin");

pub const RunFn = *const fn (*anyopaque) void;

const c = std.c;

extern fn pthread_main_np() callconv(.c) c_int;

fn isMainThread() bool {
    if (comptime builtin.os.tag == .macos or builtin.os.tag == .ios) {
        return pthread_main_np() != 0;
    }
    return true;
}

const DispatchPayload = struct {
    allocator: std.mem.Allocator,
    ctx: *anyopaque,
    run: RunFn,

    fn runAndFree(payload_ptr: *DispatchPayload) void {
        const ctx = payload_ptr.ctx;
        const run = payload_ptr.run;
        const allocator = payload_ptr.allocator;
        allocator.destroy(payload_ptr);
        run(ctx);
    }
};

extern fn zkpoker_dispatch_on_main(
    fn_ptr: *const fn (?*anyopaque) callconv(.c) void,
    ctx: ?*anyopaque,
) void;

extern fn pthread_set_qos_class_self_np(qos_class: c_uint, relative_priority: c_int) c_int;

const QOS_CLASS_USER_INITIATED: c_uint = 0x19;
const QOS_CLASS_UTILITY: c_uint = 0x11;

fn setQos(qos_class: c_uint) void {
    if (comptime builtin.os.tag != .macos and builtin.os.tag != .ios) return;
    _ = pthread_set_qos_class_self_np(qos_class, 0);
}

/// Witness and Groth16 threads inherit this. Utility QoS lets the AppKit main
/// thread preempt the prover so the table keeps painting during a prove.
pub fn setBackgroundComputeQos() void {
    setQos(QOS_CLASS_UTILITY);
}

pub fn setUserInitiatedQos() void {
    setQos(QOS_CLASS_USER_INITIATED);
}

extern fn zkpoker_dispatch_on_main_sync(
    fn_ptr: *const fn (?*anyopaque) callconv(.c) void,
    ctx: ?*anyopaque,
) void;

fn dispatchMacosEntry(payload_ptr: ?*anyopaque) callconv(.c) void {
    const payload: *DispatchPayload = @ptrCast(@alignCast(payload_ptr.?));
    payload.runAndFree();
}

/// Heap-allocates a payload and runs `run(ctx)` on the main queue (macOS) or inline when already on main.
pub fn dispatchOwned(allocator: std.mem.Allocator, ctx: *anyopaque, run: RunFn) void {
    if (isMainThread()) {
        run(ctx);
        return;
    }

    const payload = allocator.create(DispatchPayload) catch {
        run(ctx);
        return;
    };
    payload.* = .{ .allocator = allocator, .ctx = ctx, .run = run };

    if (comptime builtin.os.tag == .macos or builtin.os.tag == .ios) {
        zkpoker_dispatch_on_main(dispatchMacosEntry, payload);
        return;
    }

    payload.runAndFree();
}

fn dispatchMacosEntrySync(payload_ptr: ?*anyopaque) callconv(.c) void {
    const payload: *DispatchPayload = @ptrCast(@alignCast(payload_ptr.?));
    payload.runAndFree();
}

/// Like dispatchOwned but always waits for main-thread delivery (macOS WebView bridge completion).
pub fn dispatchOwnedSync(allocator: std.mem.Allocator, ctx: *anyopaque, run: RunFn) void {
    if (isMainThread()) {
        run(ctx);
        return;
    }

    const payload = allocator.create(DispatchPayload) catch {
        run(ctx);
        return;
    };
    payload.* = .{ .allocator = allocator, .ctx = ctx, .run = run };

    if (comptime builtin.os.tag == .macos or builtin.os.tag == .ios) {
        zkpoker_dispatch_on_main_sync(dispatchMacosEntrySync, payload);
        return;
    }

    payload.runAndFree();
}
