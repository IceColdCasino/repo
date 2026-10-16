const std = @import("std");
const paths_mod = @import("paths.zig");
const spec_mod = @import("spec.zig");
const witness_mod = @import("witness.zig");
const rs_mod = @import("rapidsnark.zig");

pub const Paths = paths_mod.Paths;
pub const CircuitId = spec_mod.CircuitId;
pub const Proof = rs_mod.Proof;
pub const json = @import("json.zig");

const ProveSlot = struct {
    wit: *witness_mod.Lib,
    handle: *anyopaque,
    prover: ?rs_mod.Prover = null,
    busy: bool = false,
};

const CachedCircuit = struct {
    wit: *witness_mod.Lib,
    short_z: [:0]u8,
    vk_json: ?[:0]u8 = null,
    slots: std.ArrayList(*ProveSlot) = .empty,
};

/// Serializes slot checkout only. Witness generation and rapidsnark run outside it.
var prove_lock: std.atomic.Mutex = .unlocked;

fn lockProve() void {
    while (!prove_lock.tryLock()) {
        std.Thread.yield() catch {};
    }
}

fn proveSlotCap() usize {
    const raw = std.c.getenv("GROTH16_PROVE_CONCURRENCY") orelse return 2;
    const n = std.fmt.parseInt(usize, std.mem.span(raw), 10) catch return 2;
    return if (n == 0) 2 else n;
}

pub const Engine = struct {
    alloc: std.mem.Allocator,
    paths: Paths,
    rapidsnark: rs_mod.Lib,
    libs: std.StringHashMap(*witness_mod.Lib),
    circuits: std.AutoHashMap(CircuitId, CachedCircuit),

    pub fn init(alloc: std.mem.Allocator) !Engine {
        var paths = try Paths.resolve(alloc);
        errdefer paths.deinit();
        const rs_path = try std.fmt.allocPrintSentinel(alloc, "{s}", .{paths.rapidsnark}, 0);
        defer alloc.free(rs_path);
        var rapidsnark = try rs_mod.Lib.open(rs_path);
        errdefer rapidsnark.close();
        return .{
            .alloc = alloc,
            .paths = paths,
            .rapidsnark = rapidsnark,
            .libs = .init(alloc),
            .circuits = .init(alloc),
        };
    }

    pub fn deinit(self: *Engine) void {
        var cit = self.circuits.iterator();
        while (cit.next()) |e| {
            // Circom `release_memory_component` already delete[]s subcomponent
            // arrays and leaves dangling pointers; `zkcasino_free` double-frees.
            for (e.value_ptr.slots.items) |slot| {
                if (slot.prover) |*prover| prover.destroy();
                self.alloc.destroy(slot);
            }
            e.value_ptr.slots.deinit(self.alloc);
            if (e.value_ptr.vk_json) |vk| self.alloc.free(vk);
            self.alloc.free(e.value_ptr.short_z);
        }
        self.circuits.deinit();

        var lit = self.libs.iterator();
        while (lit.next()) |e| {
            e.value_ptr.*.close();
            self.alloc.destroy(e.value_ptr.*);
        }
        self.libs.deinit();
        self.rapidsnark.close();
        self.paths.deinit();
    }

    fn getLib(self: *Engine, lib_name: []const u8) !*witness_mod.Lib {
        if (self.libs.get(lib_name)) |lib| return lib;
        const path = try self.paths.witnessLib(self.alloc, lib_name);
        defer self.alloc.free(path);
        const lib = try self.alloc.create(witness_mod.Lib);
        errdefer self.alloc.destroy(lib);
        lib.* = try witness_mod.Lib.open(path, self.paths.dat_dir);
        try self.libs.put(lib_name, lib);
        return lib;
    }

    /// Caller holds `prove_lock`.
    fn ensureCircuit(self: *Engine, id: CircuitId) !*CachedCircuit {
        if (self.circuits.getPtr(id)) |c| return c;
        const s = id.spec();
        const wit = try self.getLib(s.lib);
        const short_z = try self.alloc.dupeZ(u8, s.short);
        errdefer self.alloc.free(short_z);
        try self.circuits.put(id, .{
            .wit = wit,
            .short_z = short_z,
        });
        return self.circuits.getPtr(id).?;
    }

    /// Caller holds `prove_lock`. A new slot gets its own witness context.
    /// The prover (and its zkey) is opened on first use so a profile run can
    /// still build the witness before the zkey is mapped.
    fn createSlot(self: *Engine, circuit: *CachedCircuit) !*ProveSlot {
        const handle = try circuit.wit.create(circuit.short_z);
        const slot = try self.alloc.create(ProveSlot);
        slot.* = .{ .wit = circuit.wit, .handle = handle };
        try circuit.slots.append(self.alloc, slot);
        return slot;
    }

    fn openSlotProver(self: *Engine, id: CircuitId, circuit: *CachedCircuit, slot: *ProveSlot) !void {
        if (slot.prover != null) return;
        const s = id.spec();
        const zkey = try self.paths.zkeyFile(self.alloc, s.zkey);
        defer self.alloc.free(zkey);
        slot.prover = try rs_mod.Prover.open(&self.rapidsnark, zkey);
        if (circuit.vk_json == null) {
            const vk_path = try self.paths.vkFile(self.alloc, s.zkey);
            defer self.alloc.free(vk_path);
            circuit.vk_json = try readFileZ(self.alloc, vk_path);
        }
    }

    fn checkout(self: *Engine, id: CircuitId) !*ProveSlot {
        const cap = proveSlotCap();
        while (true) {
            lockProve();
            const slot = self.checkoutLocked(id, cap) catch |err| {
                prove_lock.unlock();
                return err;
            };
            if (slot) |ready| {
                prove_lock.unlock();
                return ready;
            }
            prove_lock.unlock();
            std.Thread.yield() catch {};
        }
    }

    /// Caller holds `prove_lock`. Null means every slot is busy and the cap is full.
    fn checkoutLocked(self: *Engine, id: CircuitId, cap: usize) !?*ProveSlot {
        const circuit = try self.ensureCircuit(id);
        for (circuit.slots.items) |slot| {
            if (!slot.busy) {
                slot.busy = true;
                self.openSlotProver(id, circuit, slot) catch |err| {
                    slot.busy = false;
                    return err;
                };
                return slot;
            }
        }
        if (circuit.slots.items.len >= cap) return null;
        const slot = try self.createSlot(circuit);
        slot.busy = true;
        self.openSlotProver(id, circuit, slot) catch |err| {
            slot.busy = false;
            return err;
        };
        return slot;
    }

    fn checkin(slot: *ProveSlot) void {
        lockProve();
        slot.busy = false;
        prove_lock.unlock();
    }

    pub fn proveJson(self: *Engine, id: CircuitId, input_json: []const u8) !Proof {
        // A profile run builds the witness before the zkey is mapped, so the
        // two peaks are the witness calculator and the prover separately.
        if (std.c.getenv("ZK_PROFILE") != null) {
            return self.proveProfile(id, input_json);
        }
        // The witness dylib and rapidsnark keep process-global tables.
        // Two proves at once write invalid Groth16 proofs, so the lock covers
        // witness generation and proving, not only the slot checkout.
        lockProve();
        const slot = self.checkoutHoldingLock(id) catch |err| {
            prove_lock.unlock();
            return err;
        };
        const witness_started = monoNs();
        const wtns = slot.wit.generateWtns(slot.handle, input_json, self.alloc) catch |err| {
            slot.busy = false;
            prove_lock.unlock();
            return err;
        };
        const witness_ns = monoNs() - witness_started;
        const prove_started = monoNs();
        const proof = slot.prover.?.prove(wtns, self.alloc) catch |err| {
            self.alloc.free(wtns);
            slot.busy = false;
            prove_lock.unlock();
            return err;
        };
        self.alloc.free(wtns);
        logShufflePhase(id, witness_ns, monoNs() - prove_started);
        slot.busy = false;
        prove_lock.unlock();
        return proof;
    }

    /// Caller holds `prove_lock`. The previous prove released the lock only
    /// after clearing `busy`, so a slot is free.
    fn checkoutHoldingLock(self: *Engine, id: CircuitId) !*ProveSlot {
        const slot = try self.checkoutLocked(id, proveSlotCap());
        return slot orelse error.ProveSlotBusy;
    }

    fn proveProfile(self: *Engine, id: CircuitId, input_json: []const u8) !Proof {
        lockProve();
        const circuit = self.ensureCircuit(id) catch |err| {
            prove_lock.unlock();
            return err;
        };
        const slot = if (circuit.slots.items.len == 0)
            self.createSlot(circuit) catch |err| {
                prove_lock.unlock();
                return err;
            }
        else
            circuit.slots.items[0];
        const wit = slot.wit;
        const handle = slot.handle;
        prove_lock.unlock();

        profilePhase("witness", id);
        const wtns = try wit.generateWtns(handle, input_json, self.alloc);
        defer self.alloc.free(wtns);
        profilePhase("witness_done", id);
        if (std.c.getenv("ZK_WTNS_OUT")) |path_c| {
            const path = std.mem.span(path_c);
            const f = std.c.fopen(path.ptr, "wb") orelse {
                std.debug.print("wtns write failed {s}\n", .{path});
                return error.WitnessWrite;
            };
            defer _ = std.c.fclose(f);
            if (std.c.fwrite(wtns.ptr, 1, wtns.len, f) != wtns.len) return error.WitnessWrite;
            std.debug.print("wrote witness {s} ({d} bytes)\n", .{ path, wtns.len });
        }
        if (std.c.getenv("ZK_WTNS_ONLY") != null) {
            const proof_json = try self.alloc.dupeZ(u8, "{}");
            errdefer self.alloc.free(proof_json);
            const public_json = try self.alloc.dupeZ(u8, "[]");
            return .{ .proof_json = proof_json, .public_json = public_json, .alloc = self.alloc };
        }

        lockProve();
        self.openSlotProver(id, circuit, slot) catch |err| {
            prove_lock.unlock();
            return err;
        };
        const prover = &slot.prover.?;
        prove_lock.unlock();

        profilePhase("prove", id);
        const proof = try prover.prove(wtns, self.alloc);
        profilePhase("prove_done", id);
        return proof;
    }

    pub fn verify(self: *Engine, id: CircuitId, proof: Proof) !bool {
        const slot = try self.checkout(id);
        defer checkin(slot);
        lockProve();
        const vk = self.circuits.getPtr(id).?.vk_json.?;
        prove_lock.unlock();
        return self.rapidsnark.verifyProof(proof, vk);
    }

    pub fn available(self: *Engine, id: CircuitId) bool {
        const s = id.spec();
        if (!witness_mod.exists(self.paths, self.alloc, s.lib)) return false;
        const zkey = self.paths.zkeyFile(self.alloc, s.zkey) catch return false;
        defer self.alloc.free(zkey);
        return paths_mod.exists(zkey);
    }
};

fn monoNs() i128 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(i128, ts.sec) * 1_000_000_000 + ts.nsec;
}

fn logShufflePhase(id: CircuitId, witness_ns: i128, prove_ns: i128) void {
    if (std.c.getenv("ZK_PHASE_TIME") == null) return;
    const name = @tagName(id);
    var buf: [256]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "ZK_PHASE circuit={s} witness_s={d:.3} prove_s={d:.3}\n", .{
        name,
        @as(f64, @floatFromInt(witness_ns)) / 1.0e9,
        @as(f64, @floatFromInt(prove_ns)) / 1.0e9,
    }) catch return;
    _ = std.c.write(2, msg.ptr, msg.len);
}

fn profilePhase(phase: []const u8, id: CircuitId) void {
    var buf: [128]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "PROFILE phase={s} circuit={s}\n", .{ phase, @tagName(id) }) catch return;
    _ = std.c.write(2, msg.ptr, msg.len);
}

const clib = struct {
    pub extern "c" fn fseek(stream: *std.c.FILE, offset: c_long, whence: c_int) c_int;
    pub extern "c" fn ftell(stream: *std.c.FILE) c_long;
};

fn readFileZ(alloc: std.mem.Allocator, path: [:0]const u8) ![:0]u8 {
    const f = std.c.fopen(path, "rb") orelse return error.VkOpen;
    defer _ = std.c.fclose(f);
    if (clib.fseek(f, 0, 2) != 0) return error.VkSeek;
    const size = clib.ftell(f);
    if (size < 0) return error.VkSeek;
    if (clib.fseek(f, 0, 0) != 0) return error.VkSeek;
    const n: usize = @intCast(size);
    const buf = try alloc.allocSentinel(u8, n, 0);
    const got = std.c.fread(buf.ptr, 1, n, f);
    if (got != n) {
        alloc.free(buf);
        return error.VkRead;
    }
    return buf;
}
