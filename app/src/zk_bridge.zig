const std = @import("std");
const build_options = @import("build_options");
const zero_native = @import("zero-native");
const main_thread = @import("main_thread_dispatch");
const zkey_store = @import("zkey_store");

const PROVER_OK: c_int = 0;
const PROVER_ERROR_SHORT_BUFFER: c_int = 2;

const ios_zk_stack_size: usize = 64 * 1024 * 1024;
const zk_worker_stack_size: usize = ios_zk_stack_size;

extern fn ios_embed_set_bridge_response(response: [*]const u8, len: usize) void;
extern fn zkpoker_ios_log_line(message: [*]const u8) void;
extern fn zkpoker_ios_dlopen(path: [*]const u8, err_out: ?[*]u8, err_len: usize) ?*anyopaque;
extern fn zkpoker_ios_dlsym(handle: ?*anyopaque, symbol: [*]const u8) ?*anyopaque;
extern fn zkpoker_ios_dlclose(handle: ?*anyopaque) void;
const zk_link_static = build_options.zk_link_static;
const is_ios = build_options.is_ios;

fn agentDebugLog(hypothesis_id: []const u8, location: []const u8, message: []const u8, data_json: []const u8) void {
    if (is_ios) return;
    const path = "/Users/barrett/ZK_POKER_SHARE/.cursor/debug-1d6997.log";
    const fp = std.c.fopen(path, "a") orelse return;
    defer _ = std.c.fclose(fp);
    var buf: [1536]u8 = undefined;
    const ts = @divFloor(monotonicNowNs(), 1_000_000);
    const line = std.fmt.bufPrint(
        &buf,
        "{{\"sessionId\":\"1d6997\",\"runId\":\"pre-fix\",\"hypothesisId\":\"{s}\",\"location\":\"{s}\",\"message\":\"{s}\",\"data\":{s},\"timestamp\":{d}}}\n",
        .{ hypothesis_id, location, message, if (data_json.len > 0) data_json else "{}", ts },
    ) catch return;
    _ = std.c.fwrite(line.ptr, 1, line.len, fp);
}

const groth16_prover_zkey_file = if (zk_link_static) struct {
    pub extern fn groth16_prover_zkey_file(
        zkey_file_path: [*c]const u8,
        wtns_buffer: [*]u8,
        wtns_size: u64,
        proof_buffer: [*]u8,
        proof_size: *u64,
        public_buffer: [*]u8,
        public_size: *u64,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_prover_zkey_file else struct {
    pub fn groth16_prover_zkey_file(
        _: [*c]const u8,
        _: [*]u8,
        _: u64,
        _: [*]u8,
        _: *u64,
        _: [*]u8,
        _: *u64,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_prover_zkey_file;

const groth16_public_size_for_zkey_file = if (zk_link_static) struct {
    pub extern fn groth16_public_size_for_zkey_file(
        zkey_file_path: [*c]const u8,
        public_size: *u64,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_public_size_for_zkey_file else struct {
    pub fn groth16_public_size_for_zkey_file(
        _: [*c]const u8,
        _: *u64,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_public_size_for_zkey_file;

const groth16_public_size_for_zkey_buf = if (zk_link_static) struct {
    pub extern fn groth16_public_size_for_zkey_buf(
        zkey_buffer: [*]const u8,
        zkey_size: u64,
        public_size: *u64,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_public_size_for_zkey_buf else struct {
    pub fn groth16_public_size_for_zkey_buf(
        _: [*]const u8,
        _: u64,
        _: *u64,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_public_size_for_zkey_buf;

const groth16_prover_create_zkey_file = if (zk_link_static) struct {
    pub extern fn groth16_prover_create_zkey_file(
        prover_object: *?*anyopaque,
        zkey_file_path: [*c]const u8,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_prover_create_zkey_file else struct {
    pub fn groth16_prover_create_zkey_file(
        _: *?*anyopaque,
        _: [*c]const u8,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_prover_create_zkey_file;

const groth16_prover_create = if (zk_link_static) struct {
    pub extern fn groth16_prover_create(
        prover_object: *?*anyopaque,
        zkey_buffer: [*]const u8,
        zkey_size: u64,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_prover_create else struct {
    pub fn groth16_prover_create(
        _: *?*anyopaque,
        _: [*]const u8,
        _: u64,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_prover_create;

const groth16_prover_prove = if (zk_link_static) struct {
    pub extern fn groth16_prover_prove(
        prover_object: ?*anyopaque,
        wtns_buffer: [*]const u8,
        wtns_size: u64,
        proof_buffer: [*]u8,
        proof_size: *u64,
        public_buffer: [*]u8,
        public_size: *u64,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_prover_prove else struct {
    pub fn groth16_prover_prove(
        _: ?*anyopaque,
        _: [*]const u8,
        _: u64,
        _: [*]u8,
        _: *u64,
        _: [*]u8,
        _: *u64,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_prover_prove;

const groth16_prover_destroy = if (zk_link_static) struct {
    pub extern fn groth16_prover_destroy(prover_object: ?*anyopaque) callconv(.c) void;
}.groth16_prover_destroy else struct {
    pub fn groth16_prover_destroy(_: ?*anyopaque) callconv(.c) void {}
}.groth16_prover_destroy;

const groth16_prover = if (zk_link_static) struct {
    pub extern fn groth16_prover(
        zkey_buffer: [*]const u8,
        zkey_size: u64,
        wtns_buffer: [*]const u8,
        wtns_size: u64,
        proof_buffer: [*]u8,
        proof_size: *u64,
        public_buffer: [*]u8,
        public_size: *u64,
        error_msg: [*]u8,
        error_msg_maxsize: u64,
    ) callconv(.c) c_int;
}.groth16_prover else struct {
    pub fn groth16_prover(
        _: [*]const u8,
        _: u64,
        _: [*]const u8,
        _: u64,
        _: [*]u8,
        _: *u64,
        _: [*]u8,
        _: *u64,
        _: [*]u8,
        _: u64,
    ) callconv(.c) c_int {
        return -1;
    }
}.groth16_prover;

const groth16_proof_size = if (zk_link_static) struct {
    pub extern fn groth16_proof_size(proof_size: *u64) callconv(.c) void;
}.groth16_proof_size else struct {
    pub fn groth16_proof_size(_: *u64) callconv(.c) void {}
}.groth16_proof_size;

const CircuitConfig = struct {
    lib: []const u8,
    circuit: []const u8,
};

pub const ProveOutput = struct {
    proof: []const u8,
    public_signals: []const u8,
};

const circuit_map = std.StaticStringMap(CircuitConfig).initComptime(.{
    .{ "register_main", CircuitConfig{ .lib = "zkcasino", .circuit = "register" } },
    .{ "shuffle_1_deck_52_main", CircuitConfig{ .lib = "zkcasino-shuffle-1-deck-52", .circuit = "shuffle_1_deck_52" } },
    .{ "shuffle_6_deck_52_main", CircuitConfig{ .lib = "zkcasino-shuffle-6-deck-52", .circuit = "shuffle_6_deck_52" } },
    .{ "shuffle_8_deck_52_main", CircuitConfig{ .lib = "zkcasino-shuffle-8-deck-52", .circuit = "shuffle_8_deck_52" } },
    .{ "shuffle_1_deck_37_main", CircuitConfig{ .lib = "zkcasino-shuffle-1-deck-37", .circuit = "shuffle_1_deck_37" } },
    .{ "shuffle_1_deck_38_main", CircuitConfig{ .lib = "zkcasino-shuffle-1-deck-38", .circuit = "shuffle_1_deck_38" } },
    .{ "poker_share_hashout_main", CircuitConfig{ .lib = "zkcasino-poker", .circuit = "poker_share" } },
    .{ "poker_showdown_hashout_main", CircuitConfig{ .lib = "zkcasino-poker", .circuit = "poker_showdown" } },
    .{ "baccarat_share_hashout_main", CircuitConfig{ .lib = "zkcasino-baccarat", .circuit = "baccarat_share" } },
    .{ "baccarat_showdown_hashout_main", CircuitConfig{ .lib = "zkcasino-baccarat", .circuit = "baccarat_showdown" } },
    .{ "war_share_hashout_main", CircuitConfig{ .lib = "zkcasino-war", .circuit = "war_share" } },
    .{ "war_showdown_hashout_main", CircuitConfig{ .lib = "zkcasino-war", .circuit = "war_showdown" } },
    .{ "blackjack_share_hashout_main", CircuitConfig{ .lib = "zkcasino-blackjack", .circuit = "blackjack_share" } },
    .{ "blackjack_action_hashout_main", CircuitConfig{ .lib = "zkcasino-blackjack", .circuit = "blackjack_action" } },
    .{ "blackjack_showdown_hashout_main", CircuitConfig{ .lib = "zkcasino-blackjack", .circuit = "blackjack_showdown" } },
    .{ "roulette_share_bet_37_hashout_main", CircuitConfig{ .lib = "zkcasino-roulette", .circuit = "roulette_share_bet_37" } },
    .{ "roulette_share_bet_38_hashout_main", CircuitConfig{ .lib = "zkcasino-roulette", .circuit = "roulette_share_bet_38" } },
    .{ "roulette_showdown_37_hashout_main", CircuitConfig{ .lib = "zkcasino-roulette", .circuit = "roulette_showdown_37" } },
    .{ "roulette_showdown_38_hashout_main", CircuitConfig{ .lib = "zkcasino-roulette", .circuit = "roulette_showdown_38" } },
});

const c = std.c;

const clib = struct {
    pub extern "c" fn fopen(path: [*c]const u8, mode: [*c]const u8) ?*anyopaque;
    pub extern "c" fn fclose(stream: ?*anyopaque) c_int;
    pub extern "c" fn fseek(stream: ?*anyopaque, offset: c_long, whence: c_int) c_int;
    pub extern "c" fn ftell(stream: ?*anyopaque) c_long;
    pub extern "c" fn fread(ptr: ?*anyopaque, size: usize, nmemb: usize, stream: ?*anyopaque) usize;
};

const SEEK_END: c_int = 2;
const SEEK_SET: c_int = 0;

fn lockWork(lock: *std.atomic.Mutex) void {
    while (!lock.tryLock()) {
        std.Thread.yield() catch {};
    }
}

fn unlockWork(lock: *std.atomic.Mutex) void {
    lock.unlock();
}

fn monotonicNowNs() i128 {
    var ts: c.timespec = undefined;
    if (c.clock_gettime(c.CLOCK.MONOTONIC, &ts) != 0) return 0;
    return @as(i128, ts.sec) * std.time.ns_per_s + @as(i128, @intCast(ts.nsec));
}

fn elapsedMsSince(start_ns: i128) i64 {
    return @intCast(@divTrunc(monotonicNowNs() - start_ns, std.time.ns_per_ms));
}

const ZkLib = struct {
    /// iOS: C dlopen handle (std.DynLib is unreliable on simulator).
    handle: ?*anyopaque = null,
    lib: ?std.DynLib = null,
    init: *const fn ([*c]const u8) callconv(.c) ?*anyopaque,
    get_size: *const fn (?*anyopaque) callconv(.c) u32,
    generate_wtns: *const fn (?*anyopaque, [*c]const u8, u32, ?[*]u8, *u32) callconv(.c) c_int,
    free: *const fn (?*anyopaque) callconv(.c) void,
    set_dat_root: ?*const fn (?[*]const u8, usize) callconv(.c) void = null,

    fn close(self: *ZkLib) void {
        if (is_ios) {
            if (self.handle) |h| zkpoker_ios_dlclose(h);
            self.handle = null;
        } else if (self.lib) |*dyn| {
            dyn.close();
            self.lib = null;
        }
    }
};


const RapidsnarkLib = struct {
    lib: if (zk_link_static) void else std.DynLib,
    prover_zkey_file: *const fn ([*c]const u8, [*]u8, u64, [*]u8, *u64, [*]u8, *u64, [*]u8, u64) callconv(.c) c_int,
    public_size_for_zkey_file: *const fn ([*c]const u8, *u64, [*]u8, u64) callconv(.c) c_int,
    proof_size: *const fn (*u64) callconv(.c) void,
};

const CachedZkey = struct {
    /// iOS uses zkey on disk via groth16_prover_create_zkey_file; desktop cache may hold bytes.
    bytes: []u8 = &.{},
    public_size: u64,
    prover_object: ?*anyopaque = null,
};

fn logZkStep(comptime fmt: []const u8, args: anytype) void {
    std.debug.print("[zk] " ++ fmt ++ "\n", args);
    if (is_ios) {
        var buf: [512]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "[zk] " ++ fmt, args) catch return;
        zkpoker_ios_log_line(msg.ptr);
    }
}

fn iosDlsym(handle: ?*anyopaque, comptime name: [:0]const u8) !*anyopaque {
    return zkpoker_ios_dlsym(handle, name.ptr) orelse {
        logZkStep("ios dlsym missing {s}", .{name});
        return error.MissingSymbol;
    };
}

fn validateWitnessWtns(witness: []const u8) !void {
    if (witness.len < 12) return error.WitnessBufferTooSmall;
    if (!std.mem.eql(u8, witness[0..4], "wtns")) return error.WitnessGenerateFailed;
    const version = std.mem.readInt(u32, witness[4..8], .little);
    if (version != 2) return error.WitnessGenerateFailed;
    const n_sections = std.mem.readInt(u32, witness[8..12], .little);
    if (n_sections < 2) return error.WitnessGenerateFailed;
}

pub const State = struct {
    repo_root: []const u8,
    resource_root: []const u8,
    /// When non-empty on iOS, zkeys load from `{zkey_root}/zkey/` (simulator repo mount).
    zkey_root: []const u8 = "",
    gpa: std.heap.DebugAllocator(.{}),
    cache_allocator: std.mem.Allocator,
    work_lock: std.atomic.Mutex = .unlocked,
    /// Cached dylibs + circuit handles. libzkcasino's zkcasino_free crashes after
    /// witness generation; Bun FFI never calls free. Reuse handles for app lifetime.
    zk_libs: std.StringHashMap(*ZkLib),
    circuit_handles: std.StringHashMap(?*anyopaque),
    rapidsnark: ?RapidsnarkLib = null,
    /// iOS: large zkeys are loaded into memory once and reused via groth16_prover_create.
    zkey_cache: std.StringHashMap(*CachedZkey),
    prover_error_msg: [256]u8 = undefined,
    prover_error_msg_len: usize = 0,
    /// In-flight zk.prove request ids — guards against duplicate dispatches
    /// (the WebView can re-fire a command while a long prove is running).
    in_flight_lock: std.atomic.Mutex = .unlocked,
    in_flight: std.StringHashMap(void),
    zkey_warm_lock: std.atomic.Mutex = .unlocked,
    /// Circuits with a background zkey page-cache warm already started this session.
    zkey_warm_started: std.StringHashMap(void),

    pub fn init(env_map: *std.process.Environ.Map, alloc: std.mem.Allocator) !State {
        const repo_root = try resolveRepoRoot(env_map, alloc);
        return initWithRoot(repo_root, alloc);
    }

    pub fn initEmbedded(alloc: std.mem.Allocator) !State {
        return initWithRoot(try alloc.dupe(u8, ""), alloc);
    }

    fn initWithRoot(root: []const u8, alloc: std.mem.Allocator) !State {
        const state: State = .{
            .repo_root = root,
            .resource_root = root,
            .gpa = .init,
            .cache_allocator = alloc,
            .zk_libs = std.StringHashMap(*ZkLib).init(alloc),
            .circuit_handles = std.StringHashMap(?*anyopaque).init(alloc),
            .rapidsnark = null,
            .zkey_cache = std.StringHashMap(*CachedZkey).init(alloc),
            .in_flight = std.StringHashMap(void).init(alloc),
            .zkey_warm_started = std.StringHashMap(void).init(alloc),
        };
        return state;
    }

    pub fn setResourceRoot(self: *State, root: []const u8) void {
        self.resource_root = root;
    }

    pub fn setZkeyRoot(self: *State, root: []const u8) void {
        self.zkey_root = root;
        self.configureOpenWitnessDatRoots();
    }

    pub fn deinit(self: *State, alloc: std.mem.Allocator) void {
        var lib_it = self.zk_libs.iterator();
        while (lib_it.next()) |entry| {
            const zk = entry.value_ptr.*;
            zk.close();
            self.cache_allocator.free(entry.key_ptr.*);
            self.cache_allocator.destroy(entry.value_ptr.*);
        }
        self.zk_libs.deinit();

        var handle_it = self.circuit_handles.iterator();
        while (handle_it.next()) |entry| {
            self.cache_allocator.free(entry.key_ptr.*);
        }
        self.circuit_handles.deinit();

        var zkey_it = self.zkey_cache.iterator();
        while (zkey_it.next()) |entry| {
            if (entry.value_ptr.*.prover_object) |obj| {
                groth16_prover_destroy(obj);
            }
            if (entry.value_ptr.*.bytes.len > 0) {
                self.allocator().free(entry.value_ptr.*.bytes);
            }
            self.cache_allocator.free(entry.key_ptr.*);
            self.cache_allocator.destroy(entry.value_ptr.*);
        }
        self.zkey_cache.deinit();

        {
            lockWork(&self.in_flight_lock);
            defer unlockWork(&self.in_flight_lock);
            var inf_it = self.in_flight.iterator();
            while (inf_it.next()) |entry| {
                self.cache_allocator.free(entry.key_ptr.*);
            }
        }
        self.in_flight.deinit();

        {
            lockWork(&self.zkey_warm_lock);
            defer unlockWork(&self.zkey_warm_lock);
            var warm_it = self.zkey_warm_started.iterator();
            while (warm_it.next()) |entry| {
                self.cache_allocator.free(entry.key_ptr.*);
            }
        }
        self.zkey_warm_started.deinit();

        if (self.rapidsnark) |*rs| {
            if (!zk_link_static) rs.lib.close();
        }

        alloc.free(self.repo_root);
        _ = self.gpa.deinit();
    }

    pub fn allocator(self: *State) std.mem.Allocator {
        // Prove/witness jobs run on background threads; DebugAllocator is not thread-safe.
        _ = self;
        return std.heap.smp_allocator;
    }

    /// Records an in-flight zk.prove request id. Returns false if a job with
    /// the same id is already running, or if another prove is in flight.
    fn tryBeginProveRequest(self: *State, request_id: []const u8) bool {
        lockWork(&self.in_flight_lock);
        defer unlockWork(&self.in_flight_lock);
        if (self.in_flight.contains(request_id)) return false;
        // Only one native prove at a time — concurrent jobs corrupt shared circuit handles.
        var inf_it = self.in_flight.iterator();
        if (inf_it.next() != null) return false;
        const key = self.cache_allocator.dupe(u8, request_id) catch return false;
        self.in_flight.put(key, {}) catch {
            self.cache_allocator.free(key);
            return true;
        };
        return true;
    }

    fn proveRequestInFlight(self: *State) bool {
        lockWork(&self.in_flight_lock);
        defer unlockWork(&self.in_flight_lock);
        var inf_it = self.in_flight.iterator();
        return inf_it.next() != null;
    }

    fn endProveRequest(self: *State, request_id: []const u8) void {
        lockWork(&self.in_flight_lock);
        defer unlockWork(&self.in_flight_lock);
        if (self.in_flight.fetchRemove(request_id)) |kv| {
            self.cache_allocator.free(kv.key);
        }
    }

    fn libDir(self: *State, buffer: []u8) ![]const u8 {
        if (is_ios) {
            // Witness dylibs must load from the app bundle (codesigned, in-container). Simulator
            // E2E can fopen repo paths but dlopen fails with FileNotFound outside the container.
            // zkey_root only applies to zkeys and witness .dat files (see zkeyRoot/witnessDatRoot).
            return std.fmt.bufPrint(buffer, "{s}/Frameworks", .{self.resource_root});
        }
        return std.fmt.bufPrint(buffer, "{s}/libzkcasino/zig-out/lib", .{self.repo_root});
    }

    fn zkeyRoot(self: *State) []const u8 {
        if (is_ios) {
            if (self.zkey_root.len > 0) return self.zkey_root;
            return self.resource_root;
        }
        return self.repo_root;
    }

    fn witnessDatRoot(self: *State, buffer: []u8) ?[]const u8 {
        // Prefer downloadable layout `{root}/dat` (parallel to `{root}/zkey`).
        // Fall back to the repo source tree for local/simulator mounts.
        const root = if (is_ios) self.zkeyRoot() else self.repo_root;
        var source_buf: [512]u8 = undefined;
        const source = std.fmt.bufPrintZ(&source_buf, "{s}/libzkcasino/src/zig/dat", .{root}) catch null;
        if (source) |p| {
            if (pathExists(p)) {
                return std.fmt.bufPrint(buffer, "{s}/libzkcasino/src/zig/dat", .{root}) catch null;
            }
        }
        return std.fmt.bufPrint(buffer, "{s}/dat", .{root}) catch null;
    }

    fn configureOpenWitnessDatRoots(self: *State) void {
        var dat_buf: [512]u8 = undefined;
        const dat_path = self.witnessDatRoot(&dat_buf) orelse return;
        var it = self.zk_libs.valueIterator();
        while (it.next()) |zk| {
            self.configureWitnessDatRootForLib(zk.*, dat_path);
        }
    }

    fn configureWitnessDatRootForLib(_: *State, zk: *ZkLib, dat_path: []const u8) void {
        if (zk.set_dat_root) |set_fn| {
            set_fn(dat_path.ptr, dat_path.len);
        }
    }

    fn rapidsnarkPath(self: *State, buffer: *[512]u8) ![:0]u8 {
        if (zk_link_static) {
            return buffer[0..0 :0];
        }
        if (is_ios) {
            return std.fmt.bufPrintZ(buffer, "{s}/Frameworks/librapidsnark.dylib", .{self.resource_root});
        }
        if (std.c.getenv("RAPIDSNARK_LIB")) |raw| {
            const path = std.mem.span(raw);
            if (path.len > 0 and path.len < buffer.len) {
                @memcpy(buffer[0..path.len], path);
                buffer[path.len] = 0;
                return buffer[0..path.len :0];
            }
        }
        return std.fmt.bufPrintZ(buffer, "{s}/app/zig-out/lib/libgroth16.dylib", .{self.repo_root});
    }

    fn zkeyPath(self: *State, circuit_name: []const u8, buffer: *[512]u8) ![:0]u8 {
        return std.fmt.bufPrintZ(buffer, "{s}/zkey/{s}_0001.zkey", .{ self.zkeyRoot(), circuit_name });
    }

    fn dupNullTerminated(self: *State, bytes: []const u8) ![:0]u8 {
        const copy = try self.allocator().alloc(u8, bytes.len + 1);
        errdefer self.allocator().free(copy);
        @memcpy(copy[0..bytes.len], bytes);
        copy[bytes.len] = 0;
        return copy[0..bytes.len :0];
    }

    fn witnessReturnCode(_: *State, rc: c_int) anyerror!void {
        switch (rc) {
            0 => {},
            -1 => return error.WitnessInputInvalid,
            -2 => return error.WitnessBufferTooSmall,
            -3 => return error.WitnessInputsIncomplete,
            -20 => return error.WitnessJsonParseFailed,
            -24 => return error.WitnessJsonEmpty,
            -25 => return error.WitnessJsonNotObject,
            -21 => return error.WitnessJsonQualifyFailed,
            -22 => return error.WitnessJsonToFieldFailed,
            -10 => return error.WitnessNotEnoughValues,
            -11 => return error.WitnessTooManyValues,
            -12 => return error.WitnessInvalidNumber,
            -13 => return error.WitnessInvalidJsonType,
            else => return error.WitnessGenerateFailed,
        }
    }

    fn getOrOpenZkLib(self: *State, lib_name: []const u8) !*ZkLib {
        if (self.zk_libs.get(lib_name)) |existing| {
            return existing;
        }
        const lib = try self.cache_allocator.create(ZkLib);
        errdefer self.cache_allocator.destroy(lib);
        var dat_buf: [512]u8 = undefined;
        lib.* = try self.openZkLib(lib_name);
        if (self.witnessDatRoot(&dat_buf)) |dat_path| {
            self.configureWitnessDatRootForLib(lib, dat_path);
        }
        const key = try self.cache_allocator.dupe(u8, lib_name);
        errdefer self.cache_allocator.free(key);
        try self.zk_libs.put(key, lib);
        return lib;
    }

    fn getOrInitCircuitHandle(self: *State, circuit_name: []const u8) !struct { zk: *ZkLib, handle: ?*anyopaque } {
        const config = circuit_map.get(circuit_name) orelse return error.UnknownCircuit;
        const zk = try self.getOrOpenZkLib(config.lib);

        if (self.circuit_handles.get(circuit_name)) |handle| {
            return .{ .zk = zk, .handle = handle };
        }

        var circuit_buf: [64]u8 = undefined;
        const circuit_c = try std.fmt.bufPrintZ(&circuit_buf, "{s}", .{config.circuit});
        const handle = zk.init(circuit_c.ptr) orelse return error.WitnessInitFailed;

        const key = try self.cache_allocator.dupe(u8, circuit_name);
        errdefer self.cache_allocator.free(key);
        try self.circuit_handles.put(key, handle);
        return .{ .zk = zk, .handle = handle };
    }

    fn witnessFileSizeBytes(element_count: u32) u32 {
        const header_section_size: u32 = 4 + 32 + 4;
        const witness_section_size = element_count * 32;
        return 4 + 4 + 4 + (4 + 8 + header_section_size) + (4 + 8 + witness_section_size);
    }

    fn generateWitness(self: *State, circuit_name: []const u8, input_json: []const u8) ![]u8 {
        const ctx = try self.getOrInitCircuitHandle(circuit_name);

        // dupe() uses @memcpy which panics when src/dst alias under smp_allocator.
        const json_copy = try self.allocator().alloc(u8, input_json.len + 1);
        defer self.allocator().free(json_copy);
        std.mem.copyForwards(u8, json_copy[0..input_json.len], input_json);
        json_copy[input_json.len] = 0;

        const json_len: u32 = @intCast(input_json.len);
        if (json_len == 0 or json_copy[0] != '{') {
            var dbg: [96]u8 = undefined;
            const dbg_json = std.fmt.bufPrint(&dbg, "{{\"firstByte\":{d},\"len\":{d}}}", .{
                if (input_json.len > 0) input_json[0] else 0,
                input_json.len,
            }) catch "{}";
            agentDebugLog("H2", "zk_bridge.zig:generateWitness", "WitnessJsonNotObject", dbg_json);
            return error.WitnessJsonNotObject;
        }

        const element_count = ctx.zk.get_size(ctx.handle);
        const required = witnessFileSizeBytes(element_count);

        const output = try self.allocator().alloc(u8, required);
        errdefer self.allocator().free(output);
        var actual: u32 = required;
        const gen_rc = ctx.zk.generate_wtns(ctx.handle, json_copy.ptr, json_len, output.ptr, &actual);
        if (gen_rc != 0) {
            logZkStep("generate_wtns failed rc={d} circuit={s} json_len={d}", .{ gen_rc, circuit_name, json_len });
        }
        try self.witnessReturnCode(gen_rc);
        if (actual > required) {
            return error.WitnessBufferTooSmall;
        }
        return output[0..actual];
    }

    fn openZkLib(self: *State, lib_name: []const u8) !ZkLib {
        var path_buf: [512]u8 = undefined;
        const lib_dir = try self.libDir(&path_buf);
        var full_buf: [640]u8 = undefined;
        const full = try std.fmt.bufPrintZ(&full_buf, "{s}/lib{s}.dylib", .{ lib_dir, lib_name });

        if (is_ios) {
            var err_buf: [256]u8 = undefined;
            const handle = zkpoker_ios_dlopen(full.ptr, &err_buf, err_buf.len) orelse {
                logZkStep("ios dlopen failed {s}: {s}", .{ full, err_buf[0..] });
                zkpoker_ios_log_line(full.ptr);
                zkpoker_ios_log_line(&err_buf);
                return error.FileNotFound;
            };
            errdefer zkpoker_ios_dlclose(handle);

            return .{
                .handle = handle,
                .init = @ptrCast(@alignCast(try iosDlsym(handle, "zkcasino_init"))),
                .get_size = @ptrCast(@alignCast(try iosDlsym(handle, "zkcasino_get_size"))),
                .generate_wtns = @ptrCast(@alignCast(try iosDlsym(handle, "zkcasino_generate_wtns"))),
                .free = @ptrCast(@alignCast(try iosDlsym(handle, "zkcasino_free"))),
                .set_dat_root = blk: {
                    if (zkpoker_ios_dlsym(handle, "zkcasino_set_dat_root")) |ptr| {
                        break :blk @ptrCast(@alignCast(ptr));
                    }
                    break :blk null;
                },
            };
        }

        var dyn = std.DynLib.open(full) catch |err| {
            logZkStep("open dylib failed {s}: {s}", .{ full, @errorName(err) });
            return err;
        };
        errdefer dyn.close();
        return .{
            .lib = dyn,
            .init = dyn.lookup(*const fn ([*c]const u8) callconv(.c) ?*anyopaque, "zkcasino_init") orelse return error.MissingSymbol,
            .get_size = dyn.lookup(*const fn (?*anyopaque) callconv(.c) u32, "zkcasino_get_size") orelse return error.MissingSymbol,
            .generate_wtns = dyn.lookup(*const fn (?*anyopaque, [*c]const u8, u32, ?[*]u8, *u32) callconv(.c) c_int, "zkcasino_generate_wtns") orelse return error.MissingSymbol,
            .free = dyn.lookup(*const fn (?*anyopaque) callconv(.c) void, "zkcasino_free") orelse return error.MissingSymbol,
            .set_dat_root = dyn.lookup(*const fn (?[*]const u8, usize) callconv(.c) void, "zkcasino_set_dat_root"),
        };
    }

    fn getOrOpenRapidsnark(self: *State) !*RapidsnarkLib {
        if (self.rapidsnark) |*existing| {
            return existing;
        }
        self.rapidsnark = try self.openRapidsnark();
        return &self.rapidsnark.?;
    }

    fn openRapidsnark(self: *State) !RapidsnarkLib {
        if (zk_link_static) {
            return .{
                .lib = {},
                .prover_zkey_file = groth16_prover_zkey_file,
                .public_size_for_zkey_file = groth16_public_size_for_zkey_file,
                .proof_size = groth16_proof_size,
            };
        }
        var path_buf: [512]u8 = undefined;
        const path = try self.rapidsnarkPath(&path_buf);
        var dyn = try std.DynLib.open(path);
        errdefer dyn.close();
        return .{
            .lib = dyn,
            .prover_zkey_file = dyn.lookup(*const fn ([*c]const u8, [*]u8, u64, [*]u8, *u64, [*]u8, *u64, [*]u8, u64) callconv(.c) c_int, "groth16_prover_zkey_file") orelse return error.MissingSymbol,
            .public_size_for_zkey_file = dyn.lookup(*const fn ([*c]const u8, *u64, [*]u8, u64) callconv(.c) c_int, "groth16_public_size_for_zkey_file") orelse return error.MissingSymbol,
            .proof_size = dyn.lookup(*const fn (*u64) callconv(.c) void, "groth16_proof_size") orelse return error.MissingSymbol,
        };
    }

    fn setProverErrorMsg(self: *State, err_buf: []const u8) void {
        const end = std.mem.indexOfScalar(u8, err_buf, 0) orelse err_buf.len;
        const copy_len = @min(end, self.prover_error_msg.len);
        @memcpy(self.prover_error_msg[0..copy_len], err_buf[0..copy_len]);
        self.prover_error_msg_len = copy_len;
    }

    fn proverErrorDetail(self: *State) []const u8 {
        return self.prover_error_msg[0..self.prover_error_msg_len];
    }

    fn getOrLoadCachedZkey(self: *State, circuit_name: []const u8, zkey_path: [:0]u8) !*CachedZkey {
        if (self.zkey_cache.get(circuit_name)) |existing| {
            return existing;
        }

        const plain = try zkey_store.plainPath(self.allocator(), zkey_path);
        defer self.allocator().free(plain);
        var err_buf: [256]u8 = undefined;
        var public_size: u64 = 0;
        logZkStep("loading zkey {s}", .{zkey_path});
        const load_start = monotonicNowNs();
        const pub_size_rc = groth16_public_size_for_zkey_file(plain.ptr, &public_size, &err_buf, err_buf.len);
        if (pub_size_rc != PROVER_OK) {
            self.setProverErrorMsg(&err_buf);
            logZkStep("public_size_for_zkey_file failed rc={d} zkey={s} msg={s}", .{
                pub_size_rc,
                zkey_path,
                self.proverErrorDetail(),
            });
            return error.ProverPublicSizeFailed;
        }

        var prover_object: ?*anyopaque = null;
        const create_rc = groth16_prover_create_zkey_file(@ptrCast(&prover_object), plain.ptr, &err_buf, err_buf.len);
        if (create_rc != PROVER_OK) {
            self.setProverErrorMsg(&err_buf);
            logZkStep("groth16_prover_create_zkey_file failed rc={d} zkey={s} msg={s}", .{
                create_rc,
                zkey_path,
                self.proverErrorDetail(),
            });
            return error.ProverCreateFailed;
        }
        logZkStep("groth16_prover_create_zkey_file {s} {d}ms", .{ circuit_name, elapsedMsSince(load_start) });

        const entry = try self.cache_allocator.create(CachedZkey);
        entry.* = .{
            .bytes = &.{},
            .public_size = public_size,
            .prover_object = prover_object,
        };
        const key = try self.cache_allocator.dupe(u8, circuit_name);
        errdefer self.cache_allocator.free(key);
        try self.zkey_cache.put(key, entry);
        logZkStep("zkey cached {s} public_size={d}", .{ circuit_name, public_size });
        return entry;
    }

    fn proveWithCachedZkey(
        self: *State,
        circuit_name: []const u8,
        zkey_path: [:0]u8,
        witness: []const u8,
    ) !ProveOutput {
        const cached = try self.getOrLoadCachedZkey(circuit_name, zkey_path);

        var err_buf: [256]u8 = undefined;
        var proof_size: u64 = 0;
        groth16_proof_size(&proof_size);

        const proof_margin: u64 = 100;
        const public_margin: u64 = 100;
        var proof_buffer = try self.allocator().alloc(u8, @intCast(proof_size + proof_margin));
        defer self.allocator().free(proof_buffer);
        var public_buffer = try self.allocator().alloc(u8, @intCast(cached.public_size + public_margin));
        defer self.allocator().free(public_buffer);

        var proof_len: u64 = proof_size + proof_margin;
        var public_len: u64 = cached.public_size + public_margin;

        const prover = cached.prover_object orelse return error.ProverCreateFailed;

        logZkStep("groth16_prover_prove start {s} wtns={d}", .{ circuit_name, witness.len });
        const prove_start = monotonicNowNs();
        const prove_rc = groth16_prover_prove(
            prover,
            witness.ptr,
            witness.len,
            proof_buffer.ptr,
            &proof_len,
            public_buffer.ptr,
            &public_len,
            &err_buf,
            err_buf.len,
        );
        logZkStep("groth16_prover_prove done {s} rc={d} {d}ms", .{ circuit_name, prove_rc, elapsedMsSince(prove_start) });

        if (prove_rc == PROVER_ERROR_SHORT_BUFFER) {
            proof_buffer = try self.allocator().realloc(proof_buffer, @intCast(proof_len));
            public_buffer = try self.allocator().realloc(public_buffer, @intCast(public_len));
            const retry = groth16_prover_prove(
                prover,
                witness.ptr,
                witness.len,
                proof_buffer.ptr,
                &proof_len,
                public_buffer.ptr,
                &public_len,
                &err_buf,
                err_buf.len,
            );
            if (retry != PROVER_OK) {
                self.setProverErrorMsg(&err_buf);
                logZkStep("groth16_prover_prove retry failed rc={d} msg={s}", .{ retry, self.proverErrorDetail() });
                return error.ProverFailed;
            }
        } else if (prove_rc != PROVER_OK) {
            self.setProverErrorMsg(&err_buf);
            logZkStep("groth16_prover_prove failed rc={d} msg={s}", .{ prove_rc, self.proverErrorDetail() });
            return error.ProverFailed;
        }

        const proof = try self.allocator().dupe(u8, proof_buffer[0..@intCast(proof_len)]);
        errdefer self.allocator().free(proof);
        const public_signals = try self.allocator().dupe(u8, public_buffer[0..@intCast(public_len)]);
        return .{ .proof = proof, .public_signals = public_signals };
    }

    fn proveWithZkeyFile(
        self: *State,
        zkey: [:0]u8,
        witness: []const u8,
    ) !ProveOutput {
        const plain = try zkey_store.plainPath(self.allocator(), zkey);
        defer self.allocator().free(plain);
        const rs = try self.getOrOpenRapidsnark();

        var err_buf: [256]u8 = undefined;
        var public_size: u64 = 0;
        const pub_size_rc = rs.public_size_for_zkey_file(plain.ptr, &public_size, &err_buf, err_buf.len);
        if (pub_size_rc != PROVER_OK) {
            self.setProverErrorMsg(&err_buf);
            std.debug.print("[zk] public_size_for_zkey_file failed rc={d} zkey={s} msg={s}\n", .{
                pub_size_rc,
                zkey,
                self.proverErrorDetail(),
            });
            return error.ProverPublicSizeFailed;
        }

        var proof_size: u64 = 0;
        rs.proof_size(&proof_size);

        const proof_margin: u64 = 100;
        const public_margin: u64 = 100;
        var proof_buffer = try self.allocator().alloc(u8, @intCast(proof_size + proof_margin));
        defer self.allocator().free(proof_buffer);
        var public_buffer = try self.allocator().alloc(u8, @intCast(public_size + public_margin));
        defer self.allocator().free(public_buffer);

        var proof_len: u64 = proof_size + proof_margin;
        var public_len: u64 = public_size + public_margin;

        const wtns_ptr: [*]u8 = @constCast(witness.ptr);
        const prove_rc = rs.prover_zkey_file(
            plain.ptr,
            wtns_ptr,
            witness.len,
            proof_buffer.ptr,
            &proof_len,
            public_buffer.ptr,
            &public_len,
            &err_buf,
            err_buf.len,
        );

        if (prove_rc == PROVER_ERROR_SHORT_BUFFER) {
            proof_buffer = try self.allocator().realloc(proof_buffer, @intCast(proof_len));
            public_buffer = try self.allocator().realloc(public_buffer, @intCast(public_len));
            const retry = rs.prover_zkey_file(
                plain.ptr,
                wtns_ptr,
                witness.len,
                proof_buffer.ptr,
                &proof_len,
                public_buffer.ptr,
                &public_len,
                &err_buf,
                err_buf.len,
            );
            if (retry != PROVER_OK) {
                self.setProverErrorMsg(&err_buf);
                return error.ProverFailed;
            }
        } else if (prove_rc != PROVER_OK) {
            self.setProverErrorMsg(&err_buf);
            return error.ProverFailed;
        }

        const proof = try self.allocator().dupe(u8, proof_buffer[0..@intCast(proof_len)]);
        errdefer self.allocator().free(proof);
        const public_signals = try self.allocator().dupe(u8, public_buffer[0..@intCast(public_len)]);
        return .{ .proof = proof, .public_signals = public_signals };
    }

    /// Witness + Groth16 for a circuit. Caller must not already hold `work_lock`.
    pub fn proveCircuit(self: *State, circuit_name: []const u8, inputs_json: []const u8) !ProveOutput {
        lockWork(&self.work_lock);
        defer unlockWork(&self.work_lock);
        return self.prove(circuit_name, inputs_json);
    }

    fn prove(self: *State, circuit_name: []const u8, inputs_json: []const u8) !ProveOutput {
        self.prover_error_msg_len = 0;
        const total_start = monotonicNowNs();
        const witness_start = monotonicNowNs();
        logZkStep("witness start {s}", .{circuit_name});
        const witness = try self.generateWitness(circuit_name, inputs_json);
        defer self.allocator().free(witness);
        try validateWitnessWtns(witness);
        const witness_ms = elapsedMsSince(witness_start);
        logZkStep("witness done {s} {d} bytes {d}ms", .{ circuit_name, witness.len, witness_ms });

        var zkey_buf: [512]u8 = undefined;
        const zkey = try self.zkeyPath(circuit_name, &zkey_buf);

        const prove_start = monotonicNowNs();
        const result = try self.proveWitness(circuit_name, zkey, witness);
        const prove_ms = elapsedMsSince(prove_start);
        const total_ms = elapsedMsSince(total_start);
        std.debug.print("[timing] zk.prove {s} {d}ms\n", .{ circuit_name, prove_ms });
        std.debug.print("[timing] zk.total {s} {d}ms\n", .{ circuit_name, total_ms });

        return result;
    }

    fn proveWitness(self: *State, circuit_name: []const u8, zkey: [:0]u8, witness: []const u8) !ProveOutput {
        _ = circuit_name;
        // One-shot file prover: cached groth16_prover_prove segfaults on iOS worker threads (see ZKPoker-2026-07-06-160647).
        return self.proveWithZkeyFile(zkey, witness);
    }

    fn startZkeyPageCacheWarm(self: *State, circuit_name: []const u8) !bool {
        if (circuit_map.get(circuit_name) == null) return error.UnknownCircuit;

        lockWork(&self.zkey_warm_lock);
        defer unlockWork(&self.zkey_warm_lock);
        if (self.zkey_warm_started.contains(circuit_name)) {
            return false;
        }

        const circuit = warm_job_allocator.dupe(u8, circuit_name) catch return error.OutOfMemory;
        errdefer warm_job_allocator.free(circuit);

        const key = try self.cache_allocator.dupe(u8, circuit_name);
        errdefer self.cache_allocator.free(key);
        try self.zkey_warm_started.put(key, {});

        const job = warm_job_allocator.create(WarmZkeyJob) catch return error.OutOfMemory;
        errdefer warm_job_allocator.destroy(job);
        job.* = .{ .state = self, .circuit = circuit };
        const thread = try std.Thread.spawn(.{}, WarmZkeyJob.worker, .{job});
        thread.detach();
        logZkStep("zkey warm started {s}", .{circuit_name});
        return true;
    }
};

fn readFileAll(allocator: std.mem.Allocator, path: [:0]const u8) ![]u8 {
    const file = clib.fopen(path.ptr, "rb") orelse return error.FileNotFound;
    defer _ = clib.fclose(file);
    if (clib.fseek(file, 0, SEEK_END) != 0) return error.FileSeekFailed;
    const size = clib.ftell(file);
    if (size < 0) return error.FileSeekFailed;
    if (clib.fseek(file, 0, SEEK_SET) != 0) return error.FileSeekFailed;
    const bytes = try allocator.alloc(u8, @intCast(size));
    errdefer allocator.free(bytes);
    const read_count = clib.fread(bytes.ptr, 1, @intCast(size), file);
    if (read_count != @as(usize, @intCast(size))) return error.UnexpectedEndOfFile;
    return bytes;
}

fn resolveRepoRoot(env_map: *std.process.Environ.Map, allocator: std.mem.Allocator) ![]const u8 {
    if (env_map.get("ZK_REPO_ROOT")) |value| {
        return try allocator.dupe(u8, value);
    }
    return try allocator.dupe(u8, build_options.repo_root);
}

const ProvePayload = struct {
    circuitName: []const u8 = "",
    input: ?std.json.Value = null,
    witnessFile: ?[]const u8 = null,
    /// Relative to repo root — load { circuitName, input } from disk (keeps automation commands small).
    payloadFile: ?[]const u8 = null,
};

/// Extract the raw JSON text for the value of the "input" key directly from the
/// original payload bytes sent by the bridge. This uses the exact characters
/// produced by the JS side's JSON.stringify, avoiding any std.json.Value
/// roundtrips that previously resulted in leading NUL bytes for the witness buffer.
fn findRawInputValueText(payload: []const u8) ?[]const u8 {
    // Look for "input" (as a JSON key). We accept optional whitespace around ':' .
    var search_start: usize = 0;
    while (true) {
        const key_rel = std.mem.indexOfPos(u8, payload, search_start, "\"input\"") orelse return null;
        const after = payload[key_rel + 7 ..];
        // find ':'
        const colon_rel = std.mem.indexOfScalar(u8, after, ':') orelse {
            search_start = key_rel + 7;
            continue;
        };
        var p = after[colon_rel + 1 ..];
        var i: usize = 0;
        while (i < p.len) : (i += 1) {
            const cur = p[i];
            if (cur == ' ' or cur == '\t' or cur == '\n' or cur == '\r') continue;
            if (cur == '{') {
                // balance object, handling strings
                var depth: usize = 1;
                var j = i + 1;
                while (j < p.len and depth > 0) : (j += 1) {
                    const ch = p[j];
                    if (ch == '"') {
                        j += 1;
                        while (j < p.len) {
                            if (p[j] == '\\' and j + 1 < p.len) {
                                j += 2;
                                continue;
                            }
                            if (p[j] == '"') break;
                            j += 1;
                        }
                        continue;
                    }
                    if (ch == '{') depth += 1;
                    if (ch == '}') {
                        depth -= 1;
                        if (depth == 0) {
                            return p[i .. j + 1];
                        }
                    }
                }
            }
            // if not '{', keep searching for another "input"
            search_start = key_rel + 7;
            break;
        } else {
            search_start = key_rel + 7;
        }
    }
    return null;
}

fn readRepoRelativeJson(
    self: *State,
    relative: []const u8,
) ![]const u8 {
    var path_buf: [512]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&path_buf, "{s}/{s}", .{ self.repo_root, relative });
    return readFileAll(self.allocator(), path);
}

fn extractProveArgs(
    self: *State,
    payload: []const u8,
) !struct { circuit: []const u8, input_json_buf: ?[]u8, witness_file: ?[]const u8 } {
    const allocator = self.allocator();
    // Visible diagnostic (goes to mac-app.log in E2E)
    const firstb = if (payload.len > 0) payload[0] else 0;
    logZkStep("extractProve raw_payload_len={d} first_byte={d}", .{ payload.len, firstb });

    var parsed = try std.json.parseFromSlice(ProvePayload, allocator, payload, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    var payload_file_bytes: ?[]const u8 = null;
    defer if (payload_file_bytes) |bytes| allocator.free(bytes);

    if (parsed.value.payloadFile) |rel| {
        logZkStep("extract payloadFile {s}", .{rel});
        payload_file_bytes = try readRepoRelativeJson(self, rel);
        const file_bytes = payload_file_bytes.?;
        const NestedPayload = struct {
            circuitName: []const u8,
        };
        var nested = try std.json.parseFromSlice(NestedPayload, allocator, file_bytes, .{
            .ignore_unknown_fields = true,
        });
        defer nested.deinit();
        if (nested.value.circuitName.len == 0) {
            return error.WitnessInputInvalid;
        }
        const circuit = try allocator.dupe(u8, nested.value.circuitName);
        errdefer allocator.free(circuit);

        const raw_input = findRawInputValueText(file_bytes) orelse return error.WitnessJsonNotObject;
        logZkStep("extract payloadFile raw_input len={d}", .{raw_input.len});
        if (raw_input.len == 0 or raw_input[0] != '{') {
            return error.WitnessJsonNotObject;
        }
        const input_owned = try self.cache_allocator.alloc(u8, raw_input.len + 1);
        errdefer self.cache_allocator.free(input_owned);
        @memcpy(input_owned[0..raw_input.len], raw_input);
        input_owned[raw_input.len] = 0;

        const witness_file = if (parsed.value.witnessFile) |wf| try allocator.dupe(u8, wf) else null;
        errdefer if (witness_file) |wf| allocator.free(wf);

        return .{
            .circuit = circuit,
            .input_json_buf = input_owned,
            .witness_file = witness_file,
        };
    }

    const circuit_name = parsed.value.circuitName;
    const input_value = parsed.value.input;
    if (circuit_name.len == 0) {
        return error.WitnessInputInvalid;
    }

    const circuit = try allocator.dupe(u8, circuit_name);
    errdefer allocator.free(circuit);

    const witness_file = if (parsed.value.witnessFile) |rel|
        try allocator.dupe(u8, rel)
    else
        null;
    errdefer if (witness_file) |wf| allocator.free(wf);

    var input_json_buf: ?[]u8 = null;

    // Preferred: extract the raw JSON text for the "input" value directly from the original payload bytes.
    // This uses exactly what the JS bridge produced via JSON.stringify, avoiding any Value round-trip,
    // arena lifetime, or stringify corruption that was producing leading NUL (byte0=0).
    if (findRawInputValueText(payload)) |raw| {
        logZkStep("extract raw_input found len={d} first={d}", .{ raw.len, if (raw.len > 0) raw[0] else 0 });
        if (raw.len > 0 and raw[0] == '{') {
            const input_owned = try self.cache_allocator.alloc(u8, raw.len + 1);
            errdefer self.cache_allocator.free(input_owned);
            @memcpy(input_owned[0..raw.len], raw);
            input_owned[raw.len] = 0;
            input_json_buf = input_owned;
        } else {
            logZkStep("extract raw_input did not start with brace, falling back", .{});
        }
    } else {
        logZkStep("extract raw_input not found, falling back to value path", .{});
    }

    if (input_json_buf == null) {
        if (input_value) |input_val| {
            const input_text: []const u8 = switch (input_val) {
                .string => |s| s,
                else => blk: {
                    const s = try std.json.Stringify.valueAlloc(allocator, input_val, .{});
                    break :blk s;
                },
            };
            defer if (input_val != .string) allocator.free(input_text);

            const input_str = input_text;
            logZkStep("extract fallback path str_len={d} first={d}", .{
                input_str.len,
                if (input_str.len > 0) input_str[0] else 0,
            });

            const input_owned = try self.cache_allocator.alloc(u8, input_str.len + 1);
            errdefer self.cache_allocator.free(input_owned);
            @memcpy(input_owned[0..input_str.len], input_str);
            input_owned[input_str.len] = 0;
            if (input_str.len == 0 or input_owned[0] != '{') {
                var dbg: [96]u8 = undefined;
                const dbg_json = std.fmt.bufPrint(&dbg, "{{\"firstByte\":{d},\"len\":{d}}}", .{
                    if (input_str.len > 0) input_str[0] else 0,
                    input_str.len,
                }) catch "{}";
                agentDebugLog("H2", "zk_bridge.zig:extractProveArgs", "WitnessJsonNotObject", dbg_json);
                logZkStep("extract bad input (fallback) len={d} byte0={d}", .{ input_str.len, if (input_str.len > 0) input_str[0] else 0 });
                return error.WitnessJsonNotObject;
            }
            input_json_buf = input_owned;
        }
    }

    if (witness_file == null and input_json_buf == null) {
        return error.WitnessInputInvalid;
    }

    return .{
        .circuit = circuit,
        .input_json_buf = input_json_buf,
        .witness_file = witness_file,
    };
}

fn readBundledWitness(self: *State, relative: []const u8) ![]u8 {
    var path_buf: [512]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&path_buf, "{s}/{s}", .{ self.resource_root, relative });
    return readFileAll(self.allocator(), path);
}

fn extractWitnessArgs(
    self: *State,
    payload: []const u8,
) !struct { circuit: []const u8, input_json: []const u8 } {
    const allocator = self.allocator();
    var parsed = try std.json.parseFromSlice(ProvePayload, allocator, payload, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    const input_val = parsed.value.input orelse return error.WitnessInputInvalid;
    const input_str = try std.json.Stringify.valueAlloc(allocator, input_val, .{});
    defer allocator.free(input_str);

    const input_owned = try allocator.alloc(u8, input_str.len + 1);
    errdefer allocator.free(input_owned);
    @memcpy(input_owned[0..input_str.len], input_str);
    input_owned[input_str.len] = 0;

    const circuit = try allocator.dupe(u8, parsed.value.circuitName);
    errdefer allocator.free(circuit);

    return .{
        .circuit = circuit,
        .input_json = input_owned[0..input_str.len],
    };
}

fn pathExists(path: [:0]const u8) bool {
    const file = clib.fopen(path.ptr, "rb") orelse return false;
    _ = clib.fclose(file);
    return true;
}

const DEFAULT_WARM_CIRCUIT = "poker_showdown_hashout_main";

fn parseWarmCircuitName(allocator: std.mem.Allocator, payload: []const u8) ![]const u8 {
    if (payload.len == 0) {
        return allocator.dupe(u8, DEFAULT_WARM_CIRCUIT);
    }
    const Body = struct { circuitName: ?[]const u8 = null };
    var parsed = std.json.parseFromSlice(Body, allocator, payload, .{}) catch {
        return allocator.dupe(u8, DEFAULT_WARM_CIRCUIT);
    };
    defer parsed.deinit();
    if (parsed.value.circuitName) |name| {
        if (name.len == 0) return allocator.dupe(u8, DEFAULT_WARM_CIRCUIT);
        return allocator.dupe(u8, name);
    }
    return allocator.dupe(u8, DEFAULT_WARM_CIRCUIT);
}

const warm_job_allocator = std.heap.c_allocator;

const WarmZkeyJob = struct {
    state: *State,
    circuit: []const u8,

    fn worker(job: *WarmZkeyJob) void {
        defer warm_job_allocator.free(job.circuit);
        defer warm_job_allocator.destroy(job);

        var zkey_buf: [512]u8 = undefined;
        const zkey = job.state.zkeyPath(job.circuit, &zkey_buf) catch |err| {
            logZkStep("zkey warm path failed {s} {s}", .{ job.circuit, @errorName(err) });
            return;
        };
        const plain = zkey_store.plainPath(warm_job_allocator, zkey) catch |err| {
            logZkStep("zkey warm expand failed {s} {s}", .{ job.circuit, @errorName(err) });
            return;
        };
        defer warm_job_allocator.free(plain);

        const file = clib.fopen(plain.ptr, "rb") orelse {
            logZkStep("zkey warm open failed {s}", .{plain});
            return;
        };
        defer _ = clib.fclose(file);

        const chunk_size: usize = 256 * 1024;
        const chunk_buf = warm_job_allocator.alloc(u8, chunk_size) catch {
            logZkStep("zkey warm alloc failed {s}", .{job.circuit});
            return;
        };
        defer warm_job_allocator.free(chunk_buf);

        const start = monotonicNowNs();
        var total: usize = 0;
        while (true) {
            const n = clib.fread(chunk_buf.ptr, 1, chunk_buf.len, file);
            if (n == 0) break;
            total += @intCast(n);
        }
        logZkStep("zkey warm done {s} {d} bytes {d}ms", .{ job.circuit, total, elapsedMsSince(start) });
    }
};

// macOS: zk.prove is synchronous (reliable bridge.dispatch). iOS keeps async prove.
pub const zk_sync_handler_count = 2;
pub const zk_async_handler_count = 2;

pub fn warmZkey(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *State = @ptrCast(@alignCast(context));
    const circuit = try parseWarmCircuitName(self.cache_allocator, invocation.request.payload);
    defer self.cache_allocator.free(circuit);
    const started = self.startZkeyPageCacheWarm(circuit) catch |err| {
        return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"{s}\"}}", .{@errorName(err)});
    };
    return std.fmt.bufPrint(output, "{{\"ok\":true,\"started\":{s},\"circuitName\":\"{s}\"}}", .{
        if (started) "true" else "false",
        circuit,
    });
}

pub fn ping(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *State = @ptrCast(@alignCast(context));
    var lib_buf: [512]u8 = undefined;
    const lib_dir = try self.libDir(&lib_buf);
    var dylib_buf: [640]u8 = undefined;
    const dylib_path = try std.fmt.bufPrintZ(&dylib_buf, "{s}/libzkcasino.dylib", .{lib_dir});
    var dlopen_err: [512]u8 = undefined;
    @memset(&dlopen_err, 0);
    const dylib_ok = blk: {
        if (is_ios) {
            const handle = zkpoker_ios_dlopen(dylib_path.ptr, &dlopen_err, dlopen_err.len);
            if (handle) |h| {
                zkpoker_ios_dlclose(h);
                break :blk true;
            }
            break :blk false;
        }
        break :blk pathExists(dylib_path);
    };
    const dylib_err = std.mem.sliceTo(&dlopen_err, 0);

    var shuffle_buf: [640]u8 = undefined;
    const shuffle_path = try std.fmt.bufPrintZ(&shuffle_buf, "{s}/libzkcasino-shuffle-1-deck-52.dylib", .{lib_dir});
    const shuffle_ok = pathExists(shuffle_path);

    var poker_buf: [640]u8 = undefined;
    const poker_path = try std.fmt.bufPrintZ(&poker_buf, "{s}/libzkcasino-poker.dylib", .{lib_dir});
    var poker_load_error: []const u8 = "none";
    const poker_ok = blk: {
        if (is_ios) {
            break :blk true;
        }
        if (!pathExists(poker_path)) {
            poker_load_error = "FileNotFound";
            break :blk false;
        }
        break :blk true;
    };

    var dat_buf: [512]u8 = undefined;
    const dat_path = self.witnessDatRoot(&dat_buf) orelse "";
    var dat_load_error: []const u8 = "none";
    const dat_ok = blk: {
        if (dat_path.len == 0) break :blk false;
        var dat_file_buf: [580:0]u8 = undefined;
        const dat_file = std.fmt.bufPrintZ(&dat_file_buf, "{s}/poker_share.dat", .{dat_path}) catch break :blk false;
        if (!pathExists(dat_file)) {
            dat_load_error = "FileNotFound";
            break :blk false;
        }
        break :blk true;
    };

    const platform: u32 = if (is_ios) 7 else 0;

    // Warm register witness dylib during idle ping (before first WebView prove).
    if (!is_ios) {
        _ = self.getOrInitCircuitHandle("register_main") catch {};
    }

    return std.fmt.bufPrint(output, "{{\"ok\":true,\"repoRoot\":\"{s}\",\"resourceRoot\":\"{s}\",\"zkeyRoot\":\"{s}\",\"libDir\":\"{s}\",\"dylibLoad\":{{\"ok\":{s},\"path\":\"{s}\",\"platform\":{d},\"loadError\":\"{s}\"}},\"shuffleDylibLoad\":{{\"ok\":{s},\"path\":\"{s}\"}},\"pokerDylibLoad\":{{\"ok\":{s},\"path\":\"{s}\",\"loadError\":\"{s}\"}},\"witnessDatLoad\":{{\"ok\":{s},\"path\":\"{s}\",\"loadError\":\"{s}\"}}}}", .{
        self.repo_root,
        self.resource_root,
        self.zkeyRoot(),
        lib_dir,
        if (dylib_ok) "true" else "false",
        dylib_path,
        platform,
        dylib_err,
        if (shuffle_ok) "true" else "false",
        shuffle_path,
        if (poker_ok) "true" else "false",
        poker_path,
        poker_load_error,
        if (dat_ok) "true" else "false",
        dat_path,
        dat_load_error,
    });
}

/// Synchronous prove. Not registered: Groth16 on the AppKit main thread stalls the table.
/// `zk.prove` is an async handler on every platform.
pub fn proveHandlerSync(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
    if (is_ios) return error.UnsupportedOperation;
    agentDebugLog("H2", "zk_bridge.zig:proveHandlerSync", "entry", invocation.request.id);
    const self: *State = @ptrCast(@alignCast(context));
    const allocator = self.allocator();

    const req_payload = invocation.request.payload;
    const req_first = if (req_payload.len > 0) req_payload[0] else 0;
    logZkStep("proveHandlerSync payload_len={d} first_byte={d}", .{ req_payload.len, req_first });

    if (!self.tryBeginProveRequest(invocation.request.id)) {
        agentDebugLog("H2", "zk_bridge.zig:proveHandlerSync", "ProveBusy", invocation.request.id);
        return error.ProveBusy;
    }
    defer self.endProveRequest(invocation.request.id);

    const args = try extractProveArgs(self, req_payload);
    defer allocator.free(args.circuit);
    if (args.witness_file) |wf| {
        defer allocator.free(wf);
    }
    const input_json_buf = args.input_json_buf;
    defer if (input_json_buf) |buf| self.cache_allocator.free(buf);

    const circuit = args.circuit;
    const witness_start = monotonicNowNs();

    const witness_owned = blk: {
        lockWork(&self.work_lock);
        defer unlockWork(&self.work_lock);
        if (args.witness_file) |rel| {
            logZkStep("witness load {s} from {s}", .{ circuit, rel });
            break :blk try readBundledWitness(self, rel);
        }
        const buf = input_json_buf orelse return error.WitnessInputInvalid;
        logZkStep("args input_json_buf len={d} first={d}", .{ buf.len, if (buf.len > 0) buf[0] else 0 });
        const witness_input: []const u8 = if (buf.len > 0) buf[0 .. buf.len - 1] else "";
        logZkStep("witness start {s} json_bytes={d} byte0={d}", .{ circuit, witness_input.len, if (witness_input.len > 0) witness_input[0] else 0 });
        if (witness_input.len == 0 or witness_input[0] != '{') {
            return error.WitnessJsonNotObject;
        }
        // Copy before generateWitness allocates — smp_allocator can reuse freed blocks as poisoned memory.
        const witness_copy = try self.cache_allocator.dupe(u8, witness_input);
        defer self.cache_allocator.free(witness_copy);
        break :blk self.generateWitness(circuit, witness_copy) catch |err| {
            logZkStep("witness err {s} circuit={s}", .{ @errorName(err), circuit });
            agentDebugLog("H2", "zk_bridge.zig:proveHandlerSync", "witness failed", @errorName(err));
            return err;
        };
    };
    defer allocator.free(witness_owned);
    logZkStep("witness done {s} {d} bytes {d}ms", .{ circuit, witness_owned.len, elapsedMsSince(witness_start) });

    try validateWitnessWtns(witness_owned);

    var zkey_buf: [512]u8 = undefined;
    const zkey = try self.zkeyPath(circuit, &zkey_buf);

    const prove_start = monotonicNowNs();
    logZkStep("groth16 prove start {s} wtns={d}", .{ circuit, witness_owned.len });
    const prove_result = blk: {
        lockWork(&self.work_lock);
        defer unlockWork(&self.work_lock);
        break :blk try self.proveWitness(circuit, zkey, witness_owned);
    };
    defer allocator.free(prove_result.proof);
    defer allocator.free(prove_result.public_signals);
    logZkStep("groth16 prove finished {s} {d}ms", .{ circuit, elapsedMsSince(prove_start) });

    const json = try formatProveResultJson(output, prove_result.proof, prove_result.public_signals);
    // Side-channel for host automation: WebView traffic shares bridge-response.txt and
    // can overwrite the sync envelope before the Bun poll observes it.
    writeProveAutomationSideChannel(invocation.request.id, json);
    var ok_buf: [64]u8 = undefined;
    const ok_data = std.fmt.bufPrint(&ok_buf, "{{\"jsonBytes\":{d}}}", .{json.len}) catch "{}";
    agentDebugLog("H2", "zk_bridge.zig:proveHandlerSync", "success", ok_data);
    return json;
}

/// Writes `{cwd}/.zig-cache/zero-native-automation/zk-prove-{id}.json` for host polls.
fn writeProveAutomationSideChannel(request_id: []const u8, result_json: []const u8) void {
    var path_buf: [512]u8 = undefined;
    const path_z = std.fmt.bufPrintZ(
        &path_buf,
        ".zig-cache/zero-native-automation/zk-prove-{s}.json",
        .{request_id},
    ) catch return;

    var envelope_buf: [256 * 1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&envelope_buf);
    writer.writeAll("{\"id\":") catch return;
    std.json.Stringify.value(request_id, .{}, &writer) catch return;
    writer.writeAll(",\"ok\":true,\"result\":") catch return;
    writer.writeAll(result_json) catch return;
    writer.writeAll("}") catch return;
    const envelope = writer.buffered();

    const fp = std.c.fopen(path_z, "w") orelse return;
    defer _ = std.c.fclose(fp);
    _ = std.c.fwrite(envelope.ptr, 1, envelope.len, fp);
}

/// Wrap rapidsnark JSON as *strings* so WKWebView JSON.parse of the bridge
/// envelope cannot coerce BN254 limbs into imprecise JS numbers.
fn formatProveResultJson(output: []u8, proof_json: []const u8, public_json: []const u8) ![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try writer.writeAll("{\"proofJson\":");
    try std.json.Stringify.value(proof_json, .{}, &writer);
    try writer.writeAll(",\"publicSignalsJson\":");
    try std.json.Stringify.value(public_json, .{}, &writer);
    try writer.writeAll("}");
    return writer.buffered();
}

const ProveJob = struct {
    state: *State,
    circuit: []const u8,
    /// Owned null-terminated buffer; witness input is buf[0..len-1].
    input_json_buf: ?[]u8,
    witness_file: ?[]const u8,
    request_id: []const u8,
    responder: zero_native.bridge.AsyncResponder,

    fn worker(job: *ProveJob) void {
        main_thread.setBackgroundComputeQos();
        const allocator = job.state.allocator();
        const responder = job.responder;
        const request_id = job.request_id;
        const circuit = job.circuit;
        const input_json_buf = job.input_json_buf;
        const witness_file = job.witness_file;
        defer allocator.free(circuit);
        if (witness_file) |wf| {
            defer allocator.free(wf);
        }
        if (input_json_buf) |buf| {
            defer allocator.free(buf);
        }
        defer allocator.free(request_id);
        defer allocator.destroy(job);
        defer job.state.endProveRequest(request_id);

        const witness_start = monotonicNowNs();

        if (is_ios) {
            const witness_owned = blk: {
                lockWork(&job.state.work_lock);
                defer unlockWork(&job.state.work_lock);
                if (witness_file) |rel| {
                    logZkStep("witness load {s} from {s}", .{ circuit, rel });
                    break :blk readBundledWitness(job.state, rel) catch |err| {
                        deliverBridgeFail(allocator, responder, request_id, @errorName(err));
                        return;
                    };
                }
                const buf = input_json_buf orelse {
                    deliverBridgeFail(allocator, responder, request_id, "WitnessInputInvalid");
                    return;
                };
                const witness_input: []const u8 = if (buf.len > 0) buf[0 .. buf.len - 1] else "";
                logZkStep("witness start {s} json_bytes={d}", .{ circuit, witness_input.len });
                break :blk job.state.generateWitness(circuit, witness_input) catch |err| {
                    deliverBridgeFail(allocator, responder, request_id, @errorName(err));
                    return;
                };
            };
            validateWitnessWtns(witness_owned) catch |err| {
                allocator.free(witness_owned);
                deliverBridgeFail(allocator, responder, request_id, @errorName(err));
                return;
            };
            logZkStep("witness done {s} {d} bytes {d}ms", .{ circuit, witness_owned.len, elapsedMsSince(witness_start) });
            // ProveOnlyJob acquires work_lock; do not hold it across thread spawn.
            const prove_job = allocator.create(ProveOnlyJob) catch {
                allocator.free(witness_owned);
                deliverBridgeFail(allocator, responder, request_id, "Out of memory");
                return;
            };
            const circuit_copy = allocator.dupe(u8, circuit) catch {
                allocator.free(witness_owned);
                allocator.destroy(prove_job);
                deliverBridgeFail(allocator, responder, request_id, "Out of memory");
                return;
            };
            const request_copy = allocator.dupe(u8, request_id) catch {
                allocator.free(circuit_copy);
                allocator.free(witness_owned);
                allocator.destroy(prove_job);
                deliverBridgeFail(allocator, responder, request_id, "Out of memory");
                return;
            };
            prove_job.* = .{
                .state = job.state,
                .circuit = circuit_copy,
                .witness = witness_owned,
                .request_id = request_copy,
                .responder = responder,
            };
            const thread = std.Thread.spawn(.{ .stack_size = zk_worker_stack_size }, ProveOnlyJob.worker, .{prove_job}) catch {
                allocator.free(prove_job.circuit);
                allocator.free(prove_job.request_id);
                allocator.free(witness_owned);
                allocator.destroy(prove_job);
                deliverBridgeFail(allocator, responder, request_id, "Failed to spawn prove thread");
                return;
            };
            thread.detach();
            return;
        }

        // macOS: hold work_lock for witness + prove so overlapping jobs cannot corrupt dylib state.
        lockWork(&job.state.work_lock);
        defer unlockWork(&job.state.work_lock);

        const witness_owned = blk: {
            if (witness_file) |rel| {
                logZkStep("witness load {s} from {s}", .{ circuit, rel });
                break :blk readBundledWitness(job.state, rel) catch |err| {
                    deliverBridgeFail(allocator, responder, request_id, @errorName(err));
                    return;
                };
            }
            const buf = input_json_buf orelse {
                deliverBridgeFail(allocator, responder, request_id, "WitnessInputInvalid");
                return;
            };
            const witness_input: []const u8 = if (buf.len > 0) buf[0 .. buf.len - 1] else "";
            logZkStep("witness start {s} json_bytes={d}", .{ circuit, witness_input.len });
            break :blk job.state.generateWitness(circuit, witness_input) catch |err| {
                deliverBridgeFail(allocator, responder, request_id, @errorName(err));
                return;
            };
        };
        validateWitnessWtns(witness_owned) catch |err| {
            allocator.free(witness_owned);
            deliverBridgeFail(allocator, responder, request_id, @errorName(err));
            return;
        };
        logZkStep("witness done {s} {d} bytes {d}ms", .{ circuit, witness_owned.len, elapsedMsSince(witness_start) });

        defer allocator.free(witness_owned);
        const prove_result = job.state.proveWitness(circuit, blk: {
            var zkey_buf: [512]u8 = undefined;
            break :blk job.state.zkeyPath(circuit, &zkey_buf) catch |err| {
                deliverBridgeFail(allocator, responder, request_id, @errorName(err));
                return;
            };
        }, witness_owned);

        finishProveJob(allocator, responder, request_id, circuit, job.state, prove_result);
    }
};

const ProveOnlyJob = struct {
    state: *State,
    circuit: []const u8,
    witness: []u8,
    request_id: []const u8,
    responder: zero_native.bridge.AsyncResponder,

    fn worker(job: *ProveOnlyJob) void {
        main_thread.setBackgroundComputeQos();
        const allocator = job.state.allocator();
        const responder = job.responder;
        const request_id = job.request_id;
        const circuit = job.circuit;
        const witness = job.witness;
        defer allocator.free(circuit);
        defer allocator.free(witness);
        defer allocator.free(request_id);
        defer allocator.destroy(job);

        lockWork(&job.state.work_lock);
        defer unlockWork(&job.state.work_lock);

        var zkey_buf: [512]u8 = undefined;
        const zkey = job.state.zkeyPath(circuit, &zkey_buf) catch |err| {
            deliverBridgeFail(allocator, responder, request_id, @errorName(err));
            return;
        };

        const prove_start = monotonicNowNs();
        logZkStep("groth16 prove start {s} wtns={d}", .{ circuit, witness.len });
        const prove_result = job.state.proveWitness(circuit, zkey, witness);
        logZkStep("groth16 prove finished {s} {d}ms", .{ circuit, elapsedMsSince(prove_start) });
        finishProveJob(allocator, responder, request_id, circuit, job.state, prove_result);
    }
};

fn finishProveJob(
    allocator: std.mem.Allocator,
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    circuit: []const u8,
    state: *State,
    prove_result: anyerror!ProveOutput,
) void {
    defer state.endProveRequest(request_id);
    const result = prove_result catch |err| {
        var fail_buf: [512]u8 = undefined;
        const fail_msg = if (state.prover_error_msg_len > 0)
            std.fmt.bufPrint(&fail_buf, "{s}: {s}", .{ @errorName(err), state.proverErrorDetail() }) catch @errorName(err)
        else
            @errorName(err);
        deliverBridgeFail(allocator, responder, request_id, fail_msg);
        return;
    };
    defer allocator.free(result.proof);
    defer allocator.free(result.public_signals);

    var result_buffer: [zero_native.bridge.max_result_bytes]u8 = undefined;
    const json = formatProveResultJson(result_buffer[0..], result.proof, result.public_signals) catch {
        deliverBridgeFail(allocator, responder, request_id, "Failed to format prove response");
        return;
    };

    // Bridge async response only — do not write prove-result.json file handoff.
    _ = circuit;
    deliverBridgeSuccess(allocator, responder, request_id, json);
    logZkStep("bridge deliver ok id={s} json_bytes={d}", .{ request_id, json.len });
}

const WitnessJob = struct {
    state: *State,
    circuit: []const u8,
    input_json: []const u8,
    request_id: []const u8,
    responder: zero_native.bridge.AsyncResponder,

    fn worker(job: *WitnessJob) void {
        main_thread.setBackgroundComputeQos();
        const allocator = job.state.allocator();
        const responder = job.responder;
        const request_id = job.request_id;
        const circuit = job.circuit;
        const input_json = job.input_json;
        defer allocator.free(circuit);
        defer allocator.free(input_json);
        defer allocator.free(request_id);
        defer allocator.destroy(job);

        lockWork(&job.state.work_lock);
        defer unlockWork(&job.state.work_lock);
        const witness_result = job.state.generateWitness(circuit, input_json);

        const witness = witness_result catch |err| {
            deliverBridgeFail(allocator, responder, request_id, @errorName(err));
            return;
        };
        defer allocator.free(witness);

        var result_buffer: [zero_native.bridge.max_result_bytes]u8 = undefined;
        const json = if (witness.len * 2 > 8192)
            std.fmt.bufPrint(result_buffer[0..], "{{\"size\":{d}}}", .{witness.len}) catch {
                deliverBridgeFail(allocator, responder, request_id, "Failed to format witness response");
                return;
            }
        else blk: {
            var b64_buf: [8192]u8 = undefined;
            const encoded = std.base64.standard.Encoder.encode(&b64_buf, witness);
            break :blk std.fmt.bufPrint(result_buffer[0..], "{{\"size\":{d},\"witnessBase64\":\"{s}\"}}", .{ witness.len, encoded }) catch {
                deliverBridgeFail(allocator, responder, request_id, "Failed to format witness response");
                return;
            };
        };

        deliverBridgeSuccess(allocator, responder, request_id, json);
    }
};

const RespondContext = struct {
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    body: []const u8,
    allocator: std.mem.Allocator,

    fn deliver(ctx: *anyopaque) void {
        const self: *RespondContext = @ptrCast(@alignCast(ctx));
        defer self.deinit();
        self.responder.success(self.request_id, self.body) catch {
            self.responder.fail(self.request_id, .handler_failed, "Failed to deliver bridge response") catch {};
        };
    }

    fn deinit(self: *RespondContext) void {
        self.allocator.free(self.request_id);
        self.allocator.free(self.body);
        self.allocator.destroy(self);
    }
};

const FailContext = struct {
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    message: []const u8,
    allocator: std.mem.Allocator,

    fn deliver(ctx: *anyopaque) void {
        const self: *FailContext = @ptrCast(@alignCast(ctx));
        defer self.deinit();
        self.responder.fail(self.request_id, .handler_failed, self.message) catch {};
    }

    fn deinit(self: *FailContext) void {
        self.allocator.free(self.request_id);
        self.allocator.free(self.message);
        self.allocator.destroy(self);
    }
};

fn deliverBridgeResponseIos(
    responder: zero_native.bridge.AsyncResponder,
    full_response: []const u8,
) void {
    ios_embed_set_bridge_response(full_response.ptr, full_response.len);
    responder.respond(full_response) catch {};
}

fn writeE2eProveResultFile(request_id: []const u8, circuit: []const u8, body: []const u8) void {
    const path_z = std.c.getenv("ZK_E2E_PROVE_RESULT_FILE") orelse return;
    var buffer: [zero_native.bridge.max_response_bytes + 256]u8 = undefined;
    // Include circuitName so dual clients with per-seat files can reject a
    // stale result from a prior phase if request ids collide.
    const payload = std.fmt.bufPrint(
        buffer[0..],
        "{{\"id\":\"{s}\",\"ok\":true,\"circuitName\":\"{s}\",\"result\":{s}}}",
        .{ request_id, circuit, body },
    ) catch return;
    const file = std.c.fopen(path_z, "w") orelse return;
    defer _ = std.c.fclose(file);
    _ = std.c.fwrite(payload.ptr, 1, payload.len, file);
}

fn deliverBridgeSuccess(
    allocator: std.mem.Allocator,
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    body: []const u8,
) void {
    if (is_ios) {
        var response_buffer: [zero_native.bridge.max_response_bytes]u8 = undefined;
        const full = zero_native.bridge.writeSuccessResponse(&response_buffer, request_id, body);
        deliverBridgeResponseIos(responder, full);
        return;
    }
    const DeliverCtx = struct {
        responder: zero_native.bridge.AsyncResponder,
        request_id: []const u8,
        body: []const u8,

        fn run(ctx: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.responder.success(self.request_id, self.body) catch {
                self.responder.fail(self.request_id, .handler_failed, "Failed to deliver prove response") catch {};
            };
        }
    };
    var ctx: DeliverCtx = .{ .responder = responder, .request_id = request_id, .body = body };
    main_thread.dispatchOwnedSync(allocator, &ctx, DeliverCtx.run);
}

fn deliverBridgeFail(
    allocator: std.mem.Allocator,
    responder: zero_native.bridge.AsyncResponder,
    request_id: []const u8,
    message: []const u8,
) void {
    if (is_ios) {
        var response_buffer: [zero_native.bridge.max_response_bytes]u8 = undefined;
        const full = zero_native.bridge.writeErrorResponse(&response_buffer, request_id, .handler_failed, message);
        deliverBridgeResponseIos(responder, full);
        return;
    }
    const DeliverCtx = struct {
        responder: zero_native.bridge.AsyncResponder,
        request_id: []const u8,
        message: []const u8,

        fn run(ctx: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.responder.fail(self.request_id, .handler_failed, self.message) catch {};
        }
    };
    var ctx: DeliverCtx = .{ .responder = responder, .request_id = request_id, .message = message };
    main_thread.dispatchOwnedSync(allocator, &ctx, DeliverCtx.run);
}

const WitnessGenJob = struct {
    state: *State,
    circuit: []const u8,
    input_json_buf: []u8,
    err_msg: [64]u8 = undefined,
    err_msg_len: usize = 0,
    witness: []u8 = &.{},
    failed: bool = false,

    fn worker(job: *WitnessGenJob) void {
        const witness_input: []const u8 = if (job.input_json_buf.len > 0)
            job.input_json_buf[0 .. job.input_json_buf.len - 1]
        else
            &.{};
        logZkStep("witness start {s} json_bytes={d}", .{ job.circuit, witness_input.len });
        job.witness = job.state.generateWitness(job.circuit, witness_input) catch |err| {
            job.failed = true;
            const name = @errorName(err);
            const copy_len = @min(name.len, job.err_msg.len);
            @memcpy(job.err_msg[0..copy_len], name[0..copy_len]);
            job.err_msg_len = copy_len;
            return;
        };
        validateWitnessWtns(job.witness) catch |err| {
            job.state.allocator().free(job.witness);
            job.witness = &.{};
            job.failed = true;
            const name = @errorName(err);
            const copy_len = @min(name.len, job.err_msg.len);
            @memcpy(job.err_msg[0..copy_len], name[0..copy_len]);
            job.err_msg_len = copy_len;
        };
    }
};

fn startProveJob(
    state: *State,
    invocation: zero_native.bridge.Invocation,
    responder: zero_native.bridge.AsyncResponder,
) !void {
    const allocator = state.allocator();
    const args = try extractProveArgs(state, invocation.request.payload);

    if (is_ios) zkpoker_ios_log_line("[zk] proveHandlerAsync");

    const circuit = args.circuit;
    const witness_file = args.witness_file;
    const request_id = try allocator.dupe(u8, invocation.request.id);
    var prove_ownership = struct {
        circuit: []const u8,
        request_id: []const u8,
        handed_off: bool = false,
    }{ .circuit = circuit, .request_id = request_id };
    defer if (!prove_ownership.handed_off) {
        allocator.free(prove_ownership.circuit);
        allocator.free(prove_ownership.request_id);
    };
    if (witness_file) |wf| {
        errdefer allocator.free(wf);
    }

    const witness_start = monotonicNowNs();
    const witness_owned = blk: {
        if (witness_file) |rel| {
            lockWork(&state.work_lock);
            defer unlockWork(&state.work_lock);
            logZkStep("witness load {s} from {s}", .{ circuit, rel });
            break :blk try readBundledWitness(state, rel);
        }
        const buf = args.input_json_buf orelse return error.WitnessInputInvalid;
        const gen_job = try allocator.create(WitnessGenJob);
        gen_job.* = .{
            .state = state,
            .circuit = circuit,
            .input_json_buf = buf,
        };
        // Serialize circuit init / witness gen with prove (shared State + dylib globals).
        lockWork(&state.work_lock);
        const thread = try std.Thread.spawn(.{ .stack_size = zk_worker_stack_size }, WitnessGenJob.worker, .{gen_job});
        thread.join();
        unlockWork(&state.work_lock);
        defer allocator.free(buf);
        defer allocator.destroy(gen_job);
        if (gen_job.failed) {
            const msg = gen_job.err_msg[0..gen_job.err_msg_len];
            if (msg.len > 0) {
                deliverBridgeFail(allocator, responder, request_id, msg);
                return;
            }
            deliverBridgeFail(allocator, responder, request_id, "WitnessGenerateFailed");
            return;
        }
        break :blk gen_job.witness;
    };
    logZkStep("witness done {s} {d} bytes {d}ms", .{ circuit, witness_owned.len, elapsedMsSince(witness_start) });

    validateWitnessWtns(witness_owned) catch |err| {
        allocator.free(witness_owned);
        deliverBridgeFail(allocator, responder, request_id, @errorName(err));
        return;
    };

    // Groth16 on a worker thread — witness stays on the bridge handler thread only.
    const prove_job = try allocator.create(ProveOnlyJob);
    errdefer allocator.destroy(prove_job);
    prove_job.* = .{
        .state = state,
        .circuit = circuit,
        .witness = witness_owned,
        .request_id = request_id,
        .responder = responder,
    };
    const thread = std.Thread.spawn(.{ .stack_size = zk_worker_stack_size }, ProveOnlyJob.worker, .{prove_job}) catch |err| {
        allocator.free(prove_job.circuit);
        allocator.free(prove_job.witness);
        allocator.free(prove_job.request_id);
        allocator.destroy(prove_job);
        deliverBridgeFail(allocator, responder, request_id, @errorName(err));
        return;
    };
    prove_ownership.handed_off = true;
    thread.detach();
}

fn startWitnessJob(
    state: *State,
    invocation: zero_native.bridge.Invocation,
    responder: zero_native.bridge.AsyncResponder,
) !void {
    const allocator = state.allocator();
    const args = try extractWitnessArgs(state, invocation.request.payload);

    const job = try allocator.create(WitnessJob);
    errdefer allocator.destroy(job);
    job.* = .{
        .state = state,
        .circuit = args.circuit,
        .input_json = args.input_json,
        .request_id = try allocator.dupe(u8, invocation.request.id),
        .responder = responder,
    };
    errdefer allocator.free(job.request_id);

    if (is_ios) {
        const thread = try std.Thread.spawn(.{ .stack_size = zk_worker_stack_size }, WitnessJob.worker, .{job});
        thread.detach();
        return;
    }

    const thread = try std.Thread.spawn(.{ .stack_size = zk_worker_stack_size }, WitnessJob.worker, .{job});
    thread.detach();
}

pub fn proveHandlerAsync(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
    const self: *State = @ptrCast(@alignCast(context));
    // Dedupe: the WebView can re-dispatch the same request id while a long prove
    // is still running. Drop the duplicate instead of starting a second job.
    if (!self.tryBeginProveRequest(invocation.request.id)) {
        if (self.proveRequestInFlight()) {
            logZkStep("proveHandlerAsync busy id={s} rejected", .{invocation.request.id});
            deliverBridgeFail(self.allocator(), responder, invocation.request.id, "ProveBusy");
        } else {
            logZkStep("proveHandlerAsync duplicate id={s} rejected", .{invocation.request.id});
            deliverBridgeFail(self.allocator(), responder, invocation.request.id, "ProveDuplicate");
        }
        return;
    }
    if (is_ios) zkpoker_ios_log_line("[zk] proveHandlerAsync");
    startProveJob(self, invocation, responder) catch |err| {
        self.endProveRequest(invocation.request.id);
        deliverBridgeFail(self.allocator(), responder, invocation.request.id, @errorName(err));
    };
}

pub fn witnessHandlerAsync(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
    const self: *State = @ptrCast(@alignCast(context));
    try startWitnessJob(self, invocation, responder);
}

pub fn registerHandlers(state: *State, handlers: *[zk_sync_handler_count]zero_native.BridgeHandler) void {
    handlers.* = .{
        .{ .name = "zk.ping", .context = state, .invoke_fn = ping },
        .{ .name = "zk.warmZkey", .context = state, .invoke_fn = warmZkey },
    };
}

pub fn registerAsyncHandlers(state: *State, handlers: *[zk_async_handler_count]zero_native.bridge.AsyncHandler) void {
    handlers.* = .{
        .{ .name = "zk.prove", .context = state, .invoke_fn = proveHandlerAsync },
        .{ .name = "zk.witness.generate", .context = state, .invoke_fn = witnessHandlerAsync },
    };
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
        .{ .name = "zk.ping", .origins = &bridge_origins },
        .{ .name = "zk.warmZkey", .origins = &bridge_origins },
        .{ .name = "zk.prove", .origins = &bridge_origins },
        .{ .name = "zk.witness.generate", .origins = &bridge_origins },
    };
}
