const std = @import("std");
pub const fr = @import("fr.zig");

pub const CircomCalcWit = struct {
    inputSignalAssigned: []bool,
    inputSignalAssignedCounter: u32,
    circuit: *CircomCircuit,
    signalValues: []fr.FrElement,
    circuitConstants: []fr.FrElement,
    templateInsId2IOSignalInfo: std.AutoHashMap(u32, IOFieldDefPair),
    busInsId2FieldInfo: []IOFieldDefPair,
    numThread: i32,
    maxThread: i32,
    run_fn: ?*const fn (*anyopaque) callconv(.c) void,
    allocator: std.mem.Allocator,
    vtable: *const CircuitVTable,
    cpp_ctx: ?*anyopaque,

    const Self = @This();

    pub const CircomCircuit = extern struct {
        InputHashMap: [*c]HashSignalInfo,
        witness2SignalList: [*c]u64,
        circuitConstants: [*c]fr.FrElement,
        // Padding for std::map<u32, IOFieldDefPair> (24 bytes on macOS)
        _padding: [24]u8,
        busInsId2FieldInfo: [*c]IOFieldDefPair,
        // vtable pointer (added by us, not in original circom.hpp)
        vtable: ?*const CircuitVTable,
    };

    comptime {
        // Verify the struct size matches the C++ Circom_Circuit struct
        // C++ struct: 3 pointers + 24 bytes (std::map) + 1 pointer = 56 bytes
        // We add 1 more pointer for the vtable = 64 bytes
        std.debug.assert(@sizeOf(CircomCircuit) == 64);
    }

    pub const HashSignalInfo = extern struct {
        hash: u64,
        signalid: u64,
        signalsize: u64,
    };

    pub const IOFieldDef = extern struct {
        offset: u32,
        len: u32,
        lengths: [*c]u32,
        size: u32,
        busId: u32,
    };

    pub const IOFieldDefPair = extern struct {
        len: u32,
        defs: [*c]IOFieldDef,
    };

    pub fn create(circuit: *CircomCircuit, allocator: std.mem.Allocator, run_fn: ?*const fn (*anyopaque) callconv(.c) void, vtable: *const CircuitVTable) !*Self {
        const self = try allocator.create(Self);
        errdefer allocator.destroy(self);

        const input_signal_count = vtable.get_main_input_signal_no();
        self.inputSignalAssigned = try allocator.alloc(bool, input_signal_count);
        @memset(self.inputSignalAssigned, false);
        self.inputSignalAssignedCounter = input_signal_count;

        const total_signals = vtable.get_total_signal_no();
        self.signalValues = try allocator.alloc(fr.FrElement, total_signals);
        @memset(self.signalValues, std.mem.zeroes(fr.FrElement));
        self.signalValues[0] = fr.FrElement{ .shortVal = 1, .type = fr.Fr_SHORT, .longVal = .{0} ** 4 };

        self.circuit = circuit;
        self.circuitConstants = circuit.circuitConstants[0..vtable.get_size_of_constants()];
        self.numThread = 0;
        self.maxThread = 32;
        self.run_fn = run_fn;
        self.allocator = allocator;
        self.vtable = vtable;
        self.cpp_ctx = null;

        // TODO: copy templateInsId2IOSignalInfo and busInsId2FieldInfo from circuit
        self.templateInsId2IOSignalInfo = std.AutoHashMap(u32, IOFieldDefPair).init(allocator);
        self.busInsId2FieldInfo = &[_]IOFieldDefPair{};

        return self;
    }

    pub fn reset(self: *Self) void {
        const input_signal_count = self.vtable.get_main_input_signal_no();
        @memset(self.inputSignalAssigned, false);
        self.inputSignalAssignedCounter = input_signal_count;

        @memset(self.signalValues, std.mem.zeroes(fr.FrElement));
        self.signalValues[0] = fr.FrElement{ .shortVal = 1, .type = fr.Fr_SHORT, .longVal = .{0} ** 4 };


    }

    pub fn destroy(self: *Self) void {
        self.allocator.free(self.inputSignalAssigned);
        self.allocator.free(self.signalValues);
        self.templateInsId2IOSignalInfo.deinit();
        self.allocator.destroy(self);
    }

    pub fn setInputSignal(self: *Self, h: u64, i: u32, val: fr.FrElement) void {
        if (self.inputSignalAssignedCounter == 0) {
            @panic("No more signals to be assigned");
        }
        const pos = self.getInputSignalHashPosition(h);
        if (i >= self.circuit.InputHashMap[pos].signalsize) {
            @panic("Input signal array access exceeds the size");
        }
        const si = self.circuit.InputHashMap[pos].signalid + i;
        const start = self.vtable.get_main_input_signal_start();
        if (self.inputSignalAssigned[si - start]) {
            @panic("Signal assigned twice");
        }
        self.signalValues[si] = val;
        self.inputSignalAssigned[si - start] = true;
        self.inputSignalAssignedCounter -= 1;
        self.tryRunCircuit();
    }

    pub fn tryRunCircuit(self: *Self) void {
        if (self.inputSignalAssignedCounter == 0) {
            if (self.run_fn) |run| {
                if (self.cpp_ctx) |cpp_ctx| {
                    run(cpp_ctx);
                }
            }
        }
    }

    pub const CircuitVTable = struct {
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

    pub fn getInputSignalSize(self: *Self, h: u64) u64 {
        const pos = self.getInputSignalHashPosition(h);
        return self.circuit.InputHashMap[pos].signalsize;
    }

    pub fn getRemaingInputsToBeSet(self: *Self) u32 {
        return self.inputSignalAssignedCounter;
    }

    pub fn getWitness(self: *Self, idx: u32, val: *fr.FrElement) void {
        const signal_idx = self.circuit.witness2SignalList[idx];
        if (signal_idx >= self.signalValues.len) {
            std.debug.panic("getWitness idx={d} signal_idx={d} >= signalValues.len={d}", .{
                idx, signal_idx, self.signalValues.len,
            });
        }
        fr.Fr_copy(val, &self.signalValues[signal_idx]);
    }

    fn getInputSignalHashPosition(self: *Self, h: u64) u32 {
        const n = self.vtable.get_size_of_input_hashmap();
        var pos: u32 = @intCast(h % n);
        if (self.circuit.InputHashMap[pos].hash != h) {
            const inipos = pos;
            pos = (pos + 1) % n;
            while (pos != inipos) {
                if (self.circuit.InputHashMap[pos].hash == h) return pos;
                if (self.circuit.InputHashMap[pos].signalid == 0) {
                    std.debug.print("Signal not found\n", .{});
                    @panic("getInputSignalHashPosition error");
                }
                pos = (pos + 1) % n;
            }
            std.debug.print("Signals not found\n", .{});
            @panic("getInputSignalHashPosition error");
        }
        return pos;
    }

    pub fn getTrace(self: *Self, id_cmp: u64) []const u8 {
        // TODO: implement
        _ = self;
        _ = id_cmp;
        return "";
    }

    pub fn generatePositionArray(self: *Self, dimensions: []u32, index: u32) []const u8 {
        // TODO: implement
        _ = self;
        _ = dimensions;
        _ = index;
        return "";
    }
};

// C API exports for the C++ wrapper
pub export fn zkcasino_calcwit_create(circuit: *CircomCalcWit.CircomCircuit) ?*anyopaque {
    const allocator = std.heap.page_allocator;
    const vtable = circuit.vtable orelse return null;
    const self = CircomCalcWit.create(circuit, allocator, null, vtable) catch return null;
    return self;
}

pub export fn zkcasino_calcwit_create_with_run(circuit: *CircomCalcWit.CircomCircuit, run_fn: ?*const fn (*anyopaque) callconv(.c) void) ?*anyopaque {
    const allocator = std.heap.page_allocator;
    const vtable = circuit.vtable orelse return null;
    const self = CircomCalcWit.create(circuit, allocator, run_fn, vtable) catch return null;
    return self;
}

pub export fn zkcasino_calcwit_set_cpp_ctx(ctx: *anyopaque, cpp_ctx: *anyopaque) void {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    self.cpp_ctx = cpp_ctx;
}

pub export fn zkcasino_calcwit_destroy(ctx: *anyopaque) void {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    self.destroy();
}

pub export fn zkcasino_calcwit_set_input_signal(ctx: *anyopaque, h: u64, i: u32, val: *fr.FrElement) void {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    self.setInputSignal(h, i, val.*);
}

pub export fn zkcasino_calcwit_try_run_circuit(ctx: *anyopaque) void {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    self.tryRunCircuit();
}

pub export fn zkcasino_calcwit_get_input_signal_size(ctx: *anyopaque, h: u64) u64 {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    return self.getInputSignalSize(h);
}

pub export fn zkcasino_calcwit_remaining_inputs(ctx: *anyopaque) u32 {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    return self.getRemaingInputsToBeSet();
}

pub export fn zkcasino_calcwit_get_witness(ctx: *anyopaque, idx: u32, val: *fr.FrElement) void {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    self.getWitness(idx, val);
}

pub export fn zkcasino_calcwit_get_signal_values(ctx: *anyopaque) [*c]fr.FrElement {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    return self.signalValues.ptr;
}

pub export fn zkcasino_calcwit_get_circuit_constants(ctx: *anyopaque) [*c]fr.FrElement {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    return self.circuitConstants.ptr;
}

pub export fn zkcasino_calcwit_get_trace(ctx: *anyopaque, id_cmp: u64) [*c]const u8 {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    const trace = self.getTrace(id_cmp);
    // TODO: need to store the trace string somewhere
    return trace.ptr;
}

pub export fn zkcasino_calcwit_generate_position_array(ctx: *anyopaque, dimensions: [*c]u32, size_dimensions: u32, index: u32) [*c]const u8 {
    const self = @as(*CircomCalcWit, @ptrCast(@alignCast(ctx)));
    const dims = dimensions[0..size_dimensions];
    const pos = self.generatePositionArray(dims, index);
    // TODO: need to store the string somewhere
    return pos.ptr;
}


