const std = @import("std");
const json_input = @import("json_input.zig");
const calcwit = @import("calcwit.zig");
const witness_dat = @import("witness_dat.zig");

extern "c" fn shuffle_8_deck_52_loadCircuitFromData(data: [*c]const u8, size: usize, vtable: *anyopaque) ?*anyopaque;
extern "c" fn shuffle_8_deck_52_create_ctx(circuit: *anyopaque) ?*anyopaque;
extern "c" fn shuffle_8_deck_52_get_main_input_signal_start() u32;
extern "c" fn shuffle_8_deck_52_get_main_input_signal_no() u32;
extern "c" fn shuffle_8_deck_52_get_total_signal_no() u32;
extern "c" fn shuffle_8_deck_52_get_number_of_components() u32;
extern "c" fn shuffle_8_deck_52_get_size_of_input_hashmap() u32;
extern "c" fn shuffle_8_deck_52_get_size_of_witness() u32;
extern "c" fn shuffle_8_deck_52_get_size_of_constants() u32;
extern "c" fn shuffle_8_deck_52_get_size_of_io_map() u32;
extern "c" fn shuffle_8_deck_52_get_size_of_bus_field_map() u32;

extern "c" fn zkcasino_calcwit_set_input_signal(ctx: *anyopaque, h: u64, i: u32, val: *calcwit.fr.FrElement) void;
extern "c" fn zkcasino_calcwit_try_run_circuit(ctx: *anyopaque) void;
extern "c" fn zkcasino_calcwit_remaining_inputs(ctx: *anyopaque) u32;
extern "c" fn zkcasino_calcwit_get_witness_cpp(cpp_ctx: *anyopaque, idx: u32, val: *calcwit.fr.FrElement) void;
extern "c" fn zkcasino_calcwit_get_zig_ctx(cpp_ctx: *anyopaque) *anyopaque;
extern "c" fn zkcasino_calcwit_delete_cpp_ctx(cpp_ctx: *anyopaque) void;
extern "c" fn zkcasino_calcwit_reset_cpp_ctx(cpp_ctx: *anyopaque) void;

pub const CircuitHandle = struct {
    ctx: *anyopaque,
    zig_ctx: *anyopaque,
    get_size: *const fn () callconv(.c) u32,
};

const page_allocator = std.heap.page_allocator;

const CircuitVTable = struct {
    get_main_input_signal_start: *const fn () callconv(.c) u32,
    get_main_input_signal_no: *const fn () callconv(.c) u32,
    get_total_signal_no: *const fn () callconv(.c) u32,
    get_number_of_components: *const fn () callconv(.c) u32,
    get_size_of_input_hashmap: *const fn () callconv(.c) u32,
    get_size_of_witness: *const fn () callconv(.c) u32,
    get_size_of_constants: *const fn () callconv(.c) u32,
    get_size_of_io_map: *const fn () callconv(.c) u32,
    get_size_of_bus_field_map: *const fn () callconv(.c) u32,
};

fn getCircuitFunctions(name: []const u8) ?struct {
    loadCircuit: *const fn ([*c]const u8, usize, *anyopaque) callconv(.c) ?*anyopaque,
    create_ctx: *const fn (*anyopaque) callconv(.c) ?*anyopaque,
    get_size: *const fn () callconv(.c) u32,
    vtable: CircuitVTable,
} {
    if (std.mem.eql(u8, name, "shuffle_8_deck_52")) {
        return .{
            .loadCircuit = shuffle_8_deck_52_loadCircuitFromData,
            .create_ctx = shuffle_8_deck_52_create_ctx,
            .get_size = shuffle_8_deck_52_get_size_of_witness,
            .vtable = .{
                .get_main_input_signal_start = shuffle_8_deck_52_get_main_input_signal_start,
                .get_main_input_signal_no = shuffle_8_deck_52_get_main_input_signal_no,
                .get_total_signal_no = shuffle_8_deck_52_get_total_signal_no,
                .get_number_of_components = shuffle_8_deck_52_get_number_of_components,
                .get_size_of_input_hashmap = shuffle_8_deck_52_get_size_of_input_hashmap,
                .get_size_of_witness = shuffle_8_deck_52_get_size_of_witness,
                .get_size_of_constants = shuffle_8_deck_52_get_size_of_constants,
                .get_size_of_io_map = shuffle_8_deck_52_get_size_of_io_map,
                .get_size_of_bus_field_map = shuffle_8_deck_52_get_size_of_bus_field_map,
            },
        };
    } else
    {
        return null;
    }
}

fn getCircuitData(name: []const u8) ![]const u8 {
    if (std.mem.eql(u8, name, "shuffle_8_deck_52")) return witness_dat.getCircuitDat("shuffle_8_deck_52");
    return error.UnknownCircuit;
}

pub export fn zkcasino_init(circuit_name: [*c]const u8) ?*CircuitHandle {
    const name = std.mem.span(circuit_name);

    const fns = getCircuitFunctions(name) orelse return null;

    const dat_data = getCircuitData(name) catch return null;

    const allocator = page_allocator;

    const vtable = allocator.create(CircuitVTable) catch return null;
    vtable.* = fns.vtable;

    const circuit = fns.loadCircuit(dat_data.ptr, dat_data.len, @ptrCast(@constCast(vtable))) orelse return null;

    const ctx = fns.create_ctx(circuit) orelse return null;

    const zig_ctx = zkcasino_calcwit_get_zig_ctx(ctx);

    const handle = allocator.create(CircuitHandle) catch return null;
    handle.* = .{
        .ctx = ctx,
        .zig_ctx = zig_ctx,
        .get_size = fns.get_size,
    };

    return handle;
}

pub export fn zkcasino_get_size(handle: *CircuitHandle) u32 {
    return handle.get_size();
}

pub export fn zkcasino_generate_wtns(handle: *CircuitHandle, inputs_json: [*c]const u8, inputs_json_len: u32, output: [*c]u8, output_len: *u32) c_int {
    const json_str = if (inputs_json_len > 0)
        inputs_json[0..inputs_json_len]
    else
        std.mem.span(inputs_json);
    const allocator = page_allocator;

    const ctx = @as(*calcwit.CircomCalcWit, @ptrCast(@alignCast(handle.zig_ctx)));

    if (output != null) {
        zkcasino_calcwit_reset_cpp_ctx(handle.ctx);
    }

    ctx.reset();

    json_input.loadJson(ctx, json_str, allocator) catch return -1;

    if (zkcasino_calcwit_remaining_inputs(ctx) != 0) {
        return -3;
    }
    ctx.tryRunCircuit();

    const witness_size = handle.get_size();

    const header_section_size = 4 + 32 + 4;
    const witness_section_size = witness_size * 32;
    const expected_size = 4 + 4 + 4 + (4 + 8 + header_section_size) + (4 + 8 + witness_section_size);

    if (output == null) {
        output_len.* = expected_size;
        return 0;
    }

    if (output_len.* < expected_size) {
        return -2;
    }

    var pos: u32 = 0;

    output[pos] = 'w';
    pos += 1;
    output[pos] = 't';
    pos += 1;
    output[pos] = 'n';
    pos += 1;
    output[pos] = 's';
    pos += 1;

    std.mem.writeInt(u32, output[pos..][0..4], 2, .little);
    pos += 4;

    std.mem.writeInt(u32, output[pos..][0..4], 2, .little);
    pos += 4;

    std.mem.writeInt(u32, output[pos..][0..4], 1, .little);
    pos += 4;
    std.mem.writeInt(u64, output[pos..][0..8], header_section_size, .little);
    pos += 8;

    std.mem.writeInt(u32, output[pos..][0..4], 32, .little);
    pos += 4;

    std.mem.writeInt(u64, output[pos..][0..8], 0x43e1f593f0000001, .little);
    pos += 8;
    std.mem.writeInt(u64, output[pos..][0..8], 0x2833e84879b97091, .little);
    pos += 8;
    std.mem.writeInt(u64, output[pos..][0..8], 0xb85045b68181585d, .little);
    pos += 8;
    std.mem.writeInt(u64, output[pos..][0..8], 0x30644e72e131a029, .little);
    pos += 8;

    std.mem.writeInt(u32, output[pos..][0..4], witness_size, .little);
    pos += 4;

    std.mem.writeInt(u32, output[pos..][0..4], 2, .little);
    pos += 4;
    std.mem.writeInt(u64, output[pos..][0..8], witness_section_size, .little);
    pos += 8;

    var i: u32 = 0;
    while (i < witness_size) : (i += 1) {
        var val: calcwit.fr.FrElement = undefined;
        zkcasino_calcwit_get_witness_cpp(handle.ctx, i, &val);

        var normalized = val;
        calcwit.fr.Fr_toLongNormal(&normalized, &val);

        @memcpy(output[pos .. pos + 32], std.mem.asBytes(&normalized.longVal));
        pos += 32;
    }

    output_len.* = pos;
    return 0;
}

pub export fn zkcasino_free(handle: *CircuitHandle) void {
    const allocator = page_allocator;
    zkcasino_calcwit_delete_cpp_ctx(handle.ctx);
    allocator.destroy(handle);
}
