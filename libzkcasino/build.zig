const std = @import("std");

const WitnessLib = struct {
    name: []const u8,
    api_file: []const u8,
    circuits: []const []const u8,
};

const WITNESS_LIBS = [_]WitnessLib{
    .{ .name = "zkcasino", .api_file = "src/zig/witness/register.zig", .circuits = &.{"register"} },
    .{ .name = "zkcasino-shuffle-1-deck-52", .api_file = "src/zig/witness/shuffle_1_deck_52.zig", .circuits = &.{"shuffle_1_deck_52"} },
    .{ .name = "zkcasino-shuffle-6-deck-52", .api_file = "src/zig/witness/shuffle_6_deck_52.zig", .circuits = &.{"shuffle_6_deck_52"} },
    .{ .name = "zkcasino-shuffle-8-deck-52", .api_file = "src/zig/witness/shuffle_8_deck_52.zig", .circuits = &.{"shuffle_8_deck_52"} },
    .{ .name = "zkcasino-shuffle-1-deck-37", .api_file = "src/zig/witness/shuffle_1_deck_37.zig", .circuits = &.{"shuffle_1_deck_37"} },
    .{ .name = "zkcasino-shuffle-1-deck-38", .api_file = "src/zig/witness/shuffle_1_deck_38.zig", .circuits = &.{"shuffle_1_deck_38"} },
    .{ .name = "zkcasino-poker", .api_file = "src/zig/witness/poker.zig", .circuits = &.{ "poker_share", "poker_showdown" } },
    .{ .name = "zkcasino-baccarat", .api_file = "src/zig/witness/baccarat.zig", .circuits = &.{ "baccarat_share", "baccarat_showdown" } },
    .{ .name = "zkcasino-war", .api_file = "src/zig/witness/war.zig", .circuits = &.{ "war_share", "war_showdown" } },
    .{ .name = "zkcasino-blackjack", .api_file = "src/zig/witness/blackjack.zig", .circuits = &.{ "blackjack_share", "blackjack_action", "blackjack_showdown" } },
    .{ .name = "zkcasino-roulette", .api_file = "src/zig/witness/roulette.zig", .circuits = &.{ "roulette_share", "roulette_bet_37", "roulette_bet_38", "roulette_showdown_37", "roulette_showdown_38" } },
    .{ .name = "zkcasino-shuffle-2-dice-6", .api_file = "src/zig/witness/shuffle_2_dice_6.zig", .circuits = &.{"shuffle_2_dice_6"} },
    .{ .name = "zkcasino-shuffle-1-deck-80", .api_file = "src/zig/witness/shuffle_1_deck_80.zig", .circuits = &.{"shuffle_1_deck_80"} },
    .{ .name = "zkcasino-shuffle-3-reel-22", .api_file = "src/zig/witness/shuffle_3_reel_22.zig", .circuits = &.{"shuffle_3_reel_22"} },
    .{ .name = "zkcasino-shuffle-5-reel-22", .api_file = "src/zig/witness/shuffle_5_reel_22.zig", .circuits = &.{"shuffle_5_reel_22"} },
    .{ .name = "zkcasino-craps", .api_file = "src/zig/witness/craps.zig", .circuits = &.{ "craps_share", "craps_bet", "craps_showdown" } },
    .{ .name = "zkcasino-keno", .api_file = "src/zig/witness/keno.zig", .circuits = &.{ "keno_share", "keno_bet", "keno_showdown" } },
    .{ .name = "zkcasino-slots", .api_file = "src/zig/witness/slots.zig", .circuits = &.{ "slot_share_3_reel", "slot_share_5_reel", "slot_showdown_3_reel", "slot_showdown_5_reel" } },
    .{ .name = "zkcasino-shuffle-1-deck-75", .api_file = "src/zig/witness/shuffle_1_deck_75.zig", .circuits = &.{"shuffle_1_deck_75"} },
    .{ .name = "zkcasino-shuffle-1-deck-90", .api_file = "src/zig/witness/shuffle_1_deck_90.zig", .circuits = &.{"shuffle_1_deck_90"} },
    .{ .name = "zkcasino-bingo", .api_file = "src/zig/witness/bingo.zig", .circuits = &.{ "bingo_share", "bingo_card_75", "bingo_card_90", "bingo_showdown_75", "bingo_showdown_90" } },
};

const CircuitSet = enum {
    all,
    poker,
    blackjack,
    baccarat,
    war,
    roulette,
    craps,
    keno,
    slots,
    bingo,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const witness_link = b.option(std.builtin.LinkMode, "witness-link", "Witness library linkage: dynamic or static") orelse .dynamic;
    const circuit_set = b.option(CircuitSet, "circuit-set", "Witness libraries to build") orelse .all;
    const gmp_path_opt = b.option([]const u8, "gmp-path", "Path to libgmp (.dylib, .so, or .a)");
    const gmp_path = gmp_path_opt orelse defaultGmpPath(target.result.os.tag);

    const witness_export_options = b.addOptions();
    witness_export_options.addOption(bool, "witness_exports", true);
    const witness_export_options_mod = witness_export_options.createModule();

    const witness_poker_options = b.addOptions();
    witness_poker_options.addOption(bool, "share_only", false);
    witness_poker_options.addOption(bool, "showdown_only", false);
    const witness_poker_options_mod = witness_poker_options.createModule();

    const is_apple = target.result.os.tag == .macos or target.result.os.tag == .ios;
    if (target.result.os.tag == .linux and target.result.cpu.arch != .aarch64) {
        @panic("Linux builds of libzkcasino require aarch64");
    }
    const sdk: []const u8 = if (is_apple)
        (resolveSdkPath(b, target) orelse "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk")
    else
        "";
    if (is_apple and b.sysroot == null) {
        b.sysroot = sdk;
    }

    var sdk_cxx_include_buf: [512]u8 = undefined;
    const sdk_cxx_include: []const u8 = if (is_apple)
        std.fmt.bufPrint(&sdk_cxx_include_buf, "{s}/usr/include/c++/v1", .{sdk}) catch unreachable
    else
        "";

    const rapidsnark = b.dependency("rapidsnark", .{});

    const opt_flag = switch (optimize) {
        .Debug => "-O0",
        .ReleaseSafe => "-O2",
        .ReleaseFast, .ReleaseSmall => "-O3",
    };
    var sdk_c_include_buf: [512]u8 = undefined;
    const sdk_c_include = std.fmt.bufPrint(&sdk_c_include_buf, "{s}/usr/include", .{sdk}) catch unreachable;
    const is_ios = target.result.os.tag == .ios;
    const is_ios_sim = is_ios and target.result.abi == .simulator;

    const linux_fr_cpp_flags = [_][]const u8{
        "-std=c++11",
        "-fPIC",
        opt_flag,
        "-DUSE_ASM",
        "-DARCH_ARM64",
    };
    var fr_cpp_flag_buf: [16][]const u8 = undefined;
    const fr_cpp_flags: []const []const u8 = if (is_apple)
        appendIosCppFlags(&fr_cpp_flag_buf, &.{
            "-std=c++11",
            "-fPIC",
            opt_flag,
            "-DUSE_ASM",
            "-DARCH_ARM64",
            "-stdlib=libc++",
            "-isysroot",
            sdk,
        }, is_ios, is_ios_sim, sdk_c_include)
    else
        &linux_fr_cpp_flags;

    const fr_cpp_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
    });
    addCppCompileIncludes(fr_cpp_mod, sdk_cxx_include, rapidsnark.path("build"), target.result.os.tag, target.result.os.tag == .macos or target.result.os.tag == .ios);
    fr_cpp_mod.addCSourceFile(.{ .file = rapidsnark.path("build/fr.cpp"), .flags = fr_cpp_flags });
    fr_cpp_mod.addCSourceFile(.{ .file = rapidsnark.path("build/fr_generic.cpp"), .flags = fr_cpp_flags });

    const fr_asm_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
    });
    var fr_asm_flag_buf: [16][]const u8 = undefined;
    const fr_asm_flags = if (is_ios)
        appendIosCppFlags(&fr_asm_flag_buf, &.{
            "-fPIC",
            opt_flag,
            "-isysroot",
            sdk,
        }, true, is_ios_sim, sdk_c_include)
    else
        &[_][]const u8{ "-fPIC", "-O3" };
    fr_asm_mod.addCSourceFile(.{
        .file = rapidsnark.path("build/fr_raw_arm64.s"),
        .flags = fr_asm_flags,
    });

    const fr_cpp_obj = b.addObject(.{
        .name = "fr_cpp",
        .root_module = fr_cpp_mod,
    });
    const fr_asm_obj = b.addObject(.{
        .name = "fr_asm",
        .root_module = fr_asm_mod,
    });

    const fr_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = !linksLibSystemViaTbd(target.result.os.tag),
    });
    fr_mod.addObject(fr_cpp_obj);
    fr_mod.addObject(fr_asm_obj);
    linkGmp(fr_mod, target.result.os.tag, gmp_path, gmp_path_opt != null);
    addLibcppLink(fr_mod, target, sdk);

    const fr_lib = b.addLibrary(.{
        .name = "fr",
        .root_module = fr_mod,
        .linkage = witness_link,
    });
    fr_lib.headerpad_max_install_names = true;
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        fr_lib.use_lld = false;
        fr_mod.addRPath(.{ .cwd_relative = "@loader_path" });
    }
    b.installArtifact(fr_lib);

    const linux_cpp_flags = [_][]const u8{
        "-std=c++11",
        "-fPIC",
        "-O3",
        "-fvisibility=hidden",
        "-DUSE_ASM",
        "-DARCH_ARM64",
    };
    var cpp_flag_buf: [16][]const u8 = undefined;
    const cpp_flags: []const []const u8 = if (is_apple)
        appendIosCppFlags(&cpp_flag_buf, &.{
            "-std=c++11",
            "-fPIC",
            "-O3",
            "-fvisibility=hidden",
            "-DUSE_ASM",
            "-DARCH_ARM64",
            "-stdlib=libc++",
            "-isysroot",
            sdk,
        }, is_ios, is_ios_sim, sdk_c_include)
    else
        &linux_cpp_flags;

    const cpp_common_files = [_][]const u8{
        "src/witness_common/calcwit.cpp",
        "src/witness_common/main_bridge.cpp",
    };

    for (WITNESS_LIBS) |witness_lib| {
        if (!circuitSetIncludes(circuit_set, witness_lib.name)) continue;
        addWitnessLib(b, .{
            .name = witness_lib.name,
            .api_file = witness_lib.api_file,
            .circuits = witness_lib.circuits,
            .target = target,
            .optimize = optimize,
            .sdk = sdk,
            .sdk_cxx_include = sdk_cxx_include,
            .rapidsnark_build = rapidsnark.path("build"),
            .fr_lib = fr_lib,
            .cpp_flags = cpp_flags,
            .cpp_common_files = &cpp_common_files,
            .witness_link = witness_link,
            .gmp_path = gmp_path,
            .gmp_explicit = gmp_path_opt != null,
            .witness_export_options_mod = witness_export_options_mod,
            .witness_poker_options_mod = witness_poker_options_mod,
        });
    }

    const test_step = b.step("test", "Run libzkcasino tests");

    const fr_test_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/witness/fr_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    const fr_test = b.addTest(.{
        .name = "fr_test",
        .root_module = fr_test_mod,
    });
    test_step.dependOn(&b.addRunArtifact(fr_test).step);

    const player_test_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/player_crypto_test.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    player_test_mod.addObject(fr_cpp_obj);
    player_test_mod.addObject(fr_asm_obj);
    linkGmp(player_test_mod, target.result.os.tag, gmp_path, gmp_path_opt != null);
    addLibcppLink(player_test_mod, target, sdk);

    const player_test = b.addTest(.{
        .name = "player_crypto_test",
        .root_module = player_test_mod,
    });
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        player_test.use_lld = false;
    }

    const player_test_step = b.step("player-test", "Run player-crypto golden tests (libfr-backed)");
    player_test_step.dependOn(&b.addRunArtifact(player_test).step);

    const player_lib_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/player_ffi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    player_lib_mod.addObject(fr_cpp_obj);
    player_lib_mod.addObject(fr_asm_obj);
    linkGmp(player_lib_mod, target.result.os.tag, gmp_path, gmp_path_opt != null);
    addLibcppLink(player_lib_mod, target, sdk);
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        player_lib_mod.addRPath(.{ .cwd_relative = "@loader_path" });
    }

    const player_lib = b.addLibrary(.{
        .name = "zkcasino-player",
        .root_module = player_lib_mod,
        .linkage = .dynamic,
    });
    player_lib.headerpad_max_install_names = true;
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        player_lib.use_lld = false;
    }
    b.installArtifact(player_lib);
    const player_lib_step = b.step("player-lib", "Build libzkcasino-player dylib (player math FFI)");
    player_lib_step.dependOn(&b.addInstallArtifact(player_lib, .{}).step);

    const player_bridge_lib_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/player_bridge_ffi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    player_bridge_lib_mod.addObject(fr_cpp_obj);
    player_bridge_lib_mod.addObject(fr_asm_obj);
    linkGmp(player_bridge_lib_mod, target.result.os.tag, gmp_path, gmp_path_opt != null);
    addLibcppLink(player_bridge_lib_mod, target, sdk);
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        player_bridge_lib_mod.addRPath(.{ .cwd_relative = "@loader_path" });
    }

    const player_bridge_lib = b.addLibrary(.{
        .name = "zkcasino-player-bridge",
        .root_module = player_bridge_lib_mod,
        .linkage = .dynamic,
    });
    player_bridge_lib.headerpad_max_install_names = true;
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        player_bridge_lib.use_lld = false;
    }
    b.installArtifact(player_bridge_lib);
    const player_bridge_lib_step = b.step("player-bridge-lib", "Build libzkcasino-player-bridge (Zig player Groth16 FFI)");
    player_bridge_lib_step.dependOn(&b.addInstallArtifact(player_bridge_lib, .{}).step);

    const player_prove_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/player_prove_test.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    player_prove_mod.addObject(fr_cpp_obj);
    player_prove_mod.addObject(fr_asm_obj);
    linkGmp(player_prove_mod, target.result.os.tag, gmp_path, gmp_path_opt != null);
    addLibcppLink(player_prove_mod, target, sdk);

    const player_prove_test = b.addTest(.{
        .name = "player_prove_test",
        .root_module = player_prove_mod,
    });
    if (target.result.os.tag == .macos or target.result.os.tag == .ios) {
        player_prove_test.use_lld = false;
    }
    const player_prove_step = b.step("player-prove-test", "Run Zig player Groth16 prove (witness + rapidsnark)");
    player_prove_step.dependOn(&b.addRunArtifact(player_prove_test).step);
}

const WitnessLibOptions = struct {
    name: []const u8,
    api_file: []const u8,
    circuits: []const []const u8,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    sdk: []const u8,
    sdk_cxx_include: []const u8,
    rapidsnark_build: std.Build.LazyPath,
    fr_lib: *std.Build.Step.Compile,
    cpp_flags: []const []const u8,
    cpp_common_files: []const []const u8,
    witness_link: std.builtin.LinkMode = .dynamic,
    gmp_path: []const u8,
    gmp_explicit: bool,
    witness_export_options_mod: *std.Build.Module,
    witness_poker_options_mod: *std.Build.Module,
};

fn addWitnessLib(b: *std.Build, opts: WitnessLibOptions) void {
    const lib_mod = b.createModule(.{
        .root_source_file = b.path(opts.api_file),
        .target = opts.target,
        .optimize = opts.optimize,
        .link_libc = !linksLibSystemViaTbd(opts.target.result.os.tag),
    });
    lib_mod.addObjectFile(opts.fr_lib.getEmittedBin());
    if (opts.witness_link == .dynamic) {
        linkGmp(lib_mod, opts.target.result.os.tag, opts.gmp_path, opts.gmp_explicit);
    }
    addLibcppLink(lib_mod, opts.target, opts.sdk);
    if (opts.target.result.os.tag == .macos or opts.target.result.os.tag == .ios) {
        lib_mod.addRPath(.{ .cwd_relative = "@loader_path" });
    }
    lib_mod.addImport("witness_export_options", opts.witness_export_options_mod);
    lib_mod.addImport("witness_poker_options", opts.witness_poker_options_mod);

    const lib = b.addLibrary(.{
        .name = opts.name,
        .root_module = lib_mod,
        .linkage = opts.witness_link,
    });
    lib.step.dependOn(&opts.fr_lib.step);
    if (opts.target.result.os.tag == .macos or opts.target.result.os.tag == .ios) {
        lib.use_lld = false;
    }

    for (opts.circuits) |circuit| {
        const subdir = circuitSubdir(circuit);

        var prefix_path_buf: [160]u8 = undefined;
        const prefix_path = std.fmt.bufPrint(&prefix_path_buf, "src/circuits/{s}/{s}_prefix.h", .{ subdir, circuit }) catch unreachable;

        var circuit_cpp_buf: [160]u8 = undefined;
        const circuit_cpp = std.fmt.bufPrint(&circuit_cpp_buf, "src/circuits/{s}/{s}.cpp", .{ subdir, circuit }) catch unreachable;

        const circuit_sources = [_][]const u8{
            circuit_cpp,
            opts.cpp_common_files[0],
            opts.cpp_common_files[1],
        };

        for (circuit_sources) |cpp_file| {
            const stem = std.fs.path.stem(cpp_file);

            var obj_name_buf: [160]u8 = undefined;
            const obj_name = std.fmt.bufPrint(&obj_name_buf, "{s}_{s}", .{ circuit, stem }) catch unreachable;

            // ReleaseFast: Debug -O0 Poseidon workers overflow the macOS
            // std::thread stack, and a few unsanitized Debug objects overflow
            // Zig's Mach-O linker.
            const cpp_mod = b.createModule(.{
                .target = opts.target,
                .optimize = .ReleaseFast,
                .sanitize_c = .off,
                .strip = true,
            });
            addCppCompileIncludes(cpp_mod, opts.sdk_cxx_include, opts.rapidsnark_build, opts.target.result.os.tag, opts.target.result.os.tag == .macos or opts.target.result.os.tag == .ios);
            addCppSourceWithPrefix(cpp_mod, cpp_file, prefix_path, opts.cpp_flags);

            const obj = b.addObject(.{
                .name = obj_name,
                .root_module = cpp_mod,
            });
            lib_mod.addObject(obj);
        }
    }

    b.installArtifact(lib);
}

fn linksLibSystemViaTbd(os_tag: std.Target.Os.Tag) bool {
    // iOS static/dylib packaging uses SDK .tbd stubs. macOS uses link_libc to avoid
    // duplicate LC_LOAD_DYLIB entries for libSystem (breaks Bun dlopen).
    return os_tag == .ios;
}

fn addLibcppLink(module: *std.Build.Module, target: std.Build.ResolvedTarget, sdk: []const u8) void {
    if (target.result.os.tag == .ios) {
        var libsystem_buf: [512]u8 = undefined;
        const libsystem_tbd = std.fmt.bufPrint(&libsystem_buf, "{s}/usr/lib/libSystem.tbd", .{sdk}) catch unreachable;
        var libcxx_buf: [512]u8 = undefined;
        const libcxx_tbd = std.fmt.bufPrint(&libcxx_buf, "{s}/usr/lib/libc++.tbd", .{sdk}) catch unreachable;
        var libcxxabi_buf: [512]u8 = undefined;
        const libcxxabi_tbd = std.fmt.bufPrint(&libcxxabi_buf, "{s}/usr/lib/libc++abi.tbd", .{sdk}) catch unreachable;
        module.addObjectFile(.{ .cwd_relative = libsystem_tbd });
        module.addObjectFile(.{ .cwd_relative = libcxx_tbd });
        module.addObjectFile(.{ .cwd_relative = libcxxabi_tbd });
        return;
    }
    if (target.result.os.tag == .macos) {
        var libcxx_buf: [512]u8 = undefined;
        const libcxx_tbd = std.fmt.bufPrint(&libcxx_buf, "{s}/usr/lib/libc++.tbd", .{sdk}) catch unreachable;
        var libcxxabi_buf: [512]u8 = undefined;
        const libcxxabi_tbd = std.fmt.bufPrint(&libcxxabi_buf, "{s}/usr/lib/libc++abi.tbd", .{sdk}) catch unreachable;
        module.addObjectFile(.{ .cwd_relative = libcxx_tbd });
        module.addObjectFile(.{ .cwd_relative = libcxxabi_tbd });
        return;
    }

    // linkSystemLibrary("stdc++") is rewritten to Zig's bundled libc++.
    // These objects are compiled against the system libstdc++ headers.
    module.addObjectFile(.{ .cwd_relative = "/usr/lib/aarch64-linux-gnu/libstdc++.so" });
}

fn appendIosCppFlags(
    out: *[16][]const u8,
    base: []const []const u8,
    is_ios: bool,
    is_ios_sim: bool,
    sdk_c_include: []const u8,
) []const []const u8 {
    var len: usize = 0;
    for (base) |flag| {
        out[len] = flag;
        len += 1;
    }
    if (is_ios) {
        out[len] = "-isystem";
        len += 1;
        out[len] = sdk_c_include;
        len += 1;
    }
    if (is_ios_sim) {
        out[len] = "-DTARGET_OS_SIM=1";
        len += 1;
    }
    return out[0..len];
}

fn addCppCompileIncludes(
    module: *std.Build.Module,
    sdk_cxx_include: []const u8,
    rapidsnark_build: std.Build.LazyPath,
    os_tag: std.Target.Os.Tag,
    include_gmp_headers: bool,
) void {
    if (sdk_cxx_include.len > 0) {
        module.addIncludePath(.{ .cwd_relative = sdk_cxx_include });
    }
    if (os_tag == .linux) addLinuxCxxIncludes(module);
    module.addIncludePath(module.owner.path("src/witness_common"));
    module.addIncludePath(rapidsnark_build);
    if (include_gmp_headers) {
        module.addIncludePath(.{ .cwd_relative = gmpIncludePath(os_tag) });
    }
}

fn gmpIncludePath(os_tag: std.Target.Os.Tag) []const u8 {
    return switch (os_tag) {
        .ios => "../rapidsnark/lib/ios-simulator/include",
        else => "/opt/homebrew/include",
    };
}

fn addCppSourceWithPrefix(
    module: *std.Build.Module,
    cpp_file: []const u8,
    prefix_h: []const u8,
    flags_slice: []const []const u8,
) void {
    const all_flags = module.owner.allocator.alloc([]const u8, flags_slice.len + 2) catch unreachable;
    defer module.owner.allocator.free(all_flags);

    for (flags_slice, 0..) |flag, i| {
        all_flags[i] = flag;
    }
    all_flags[flags_slice.len] = "-include";
    all_flags[flags_slice.len + 1] = prefix_h;

    module.addCSourceFile(.{
        .file = module.owner.path(cpp_file),
        .flags = all_flags,
    });
}

fn macosSdkPath(b: *std.Build) ?[]const u8 {
    return sdkPath(b, "macosx");
}

fn iosSdkPath(b: *std.Build, simulator: bool) ?[]const u8 {
    return sdkPath(b, if (simulator) "iphonesimulator" else "iphoneos");
}

fn sdkPath(b: *std.Build, sdk: []const u8) ?[]const u8 {
    if (b.graph.environ_map.get("SDKROOT")) |sdkroot| {
        if (sdkroot.len > 0) return sdkroot;
    }

    const result = std.process.run(b.allocator, b.graph.io, .{
        .argv = &.{ "xcrun", "--sdk", sdk, "--show-sdk-path" },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    }) catch return null;
    defer b.allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) {
        b.allocator.free(result.stdout);
        return null;
    }
    return std.mem.trimEnd(u8, result.stdout, "\r\n");
}

fn resolveSdkPath(b: *std.Build, target: std.Build.ResolvedTarget) ?[]const u8 {
    return switch (target.result.os.tag) {
        .ios => iosSdkPath(b, target.result.abi == .simulator),
        .macos => macosSdkPath(b),
        else => macosSdkPath(b),
    };
}

fn defaultGmpPath(os_tag: std.Target.Os.Tag) []const u8 {
    return switch (os_tag) {
        .ios => "../rapidsnark/lib/ios-simulator/lib/libgmp.a",
        else => "/opt/homebrew/lib/libgmp.dylib",
    };
}

fn addLinuxCxxIncludes(module: *std.Build.Module) void {
    const b = module.owner;
    var dir = std.Io.Dir.openDirAbsolute(b.graph.io, "/usr/include/c++", .{ .iterate = true }) catch
        @panic("Linux C++ builds need g++ (/usr/include/c++ is missing)");
    defer dir.close(b.graph.io);
    var it = dir.iterate();
    const ver = while (it.next(b.graph.io) catch null) |ent| {
        if (ent.kind == .directory) break b.dupe(ent.name);
    } else @panic("Linux C++ builds need g++ (/usr/include/c++ is empty)");

    const cxx = b.fmt("/usr/include/c++/{s}", .{ver});
    const arch = b.fmt("/usr/include/aarch64-linux-gnu/c++/{s}", .{ver});
    const bits = b.fmt("/usr/include/c++/{s}/aarch64-linux-gnu", .{ver});
    module.addIncludePath(.{ .cwd_relative = cxx });
    module.addIncludePath(.{ .cwd_relative = arch });
    module.addIncludePath(.{ .cwd_relative = bits });
    module.addIncludePath(.{ .cwd_relative = "/usr/include" });
}

fn linkGmp(module: *std.Build.Module, os_tag: std.Target.Os.Tag, gmp_path: []const u8, explicit: bool) void {
    if (os_tag == .linux and !explicit) {
        module.linkSystemLibrary("gmp", .{});
        return;
    }
    module.addObjectFile(.{ .cwd_relative = gmp_path });
}

fn circuitSetIncludes(set: CircuitSet, name: []const u8) bool {
    if (std.mem.eql(u8, name, "zkcasino")) return true;
    return switch (set) {
        .all => true,
        .poker => std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-52") or std.mem.eql(u8, name, "zkcasino-poker"),
        .blackjack => std.mem.eql(u8, name, "zkcasino-shuffle-6-deck-52") or std.mem.eql(u8, name, "zkcasino-blackjack"),
        .baccarat => std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-52") or std.mem.eql(u8, name, "zkcasino-baccarat"),
        .war => std.mem.eql(u8, name, "zkcasino-shuffle-6-deck-52") or std.mem.eql(u8, name, "zkcasino-war"),
        .roulette => std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-37") or std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-38") or std.mem.eql(u8, name, "zkcasino-roulette"),
        .craps => std.mem.eql(u8, name, "zkcasino-shuffle-2-dice-6") or std.mem.eql(u8, name, "zkcasino-craps"),
        .keno => std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-80") or std.mem.eql(u8, name, "zkcasino-keno"),
        .slots => std.mem.eql(u8, name, "zkcasino-shuffle-3-reel-22") or std.mem.eql(u8, name, "zkcasino-shuffle-5-reel-22") or std.mem.eql(u8, name, "zkcasino-slots"),
        .bingo => std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-75") or std.mem.eql(u8, name, "zkcasino-shuffle-1-deck-90") or std.mem.eql(u8, name, "zkcasino-bingo"),
    };
}

fn circuitSubdir(name: []const u8) []const u8 {
    if (std.mem.eql(u8, name, "register")) return "register";
    const groups = [_]struct { []const u8, []const u8 }{
        .{ "shuffle_", "shuffle" },
        .{ "poker_", "poker" },
        .{ "baccarat_", "baccarat" },
        .{ "war_", "war" },
        .{ "blackjack_", "blackjack" },
        .{ "roulette_", "roulette" },
        .{ "craps_", "craps" },
        .{ "keno_", "keno" },
        .{ "slot_", "slots" },
        .{ "bingo_", "bingo" },
    };
    for (groups) |group| {
        if (std.mem.startsWith(u8, name, group[0])) return group[1];
    }
    unreachable;
}