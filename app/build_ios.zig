const std = @import("std");

const default_zero_native_path = "../node_modules/zero-native";

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});
    const zero_native_path = b.option([]const u8, "zero-native-path", "Path to the zero-native framework checkout") orelse default_zero_native_path;
    const repo_root = repoRootPath(b) orelse b.pathJoin(&.{ b.build_root.path.?, ".." });

    const ios_target_name = b.option([]const u8, "ios-target", "iOS cross-compilation triple (e.g. aarch64-ios-simulator, aarch64-ios)") orelse "aarch64-ios-simulator";
    const ios_query = std.Target.Query.parse(.{ .arch_os_abi = ios_target_name }) catch unreachable;
    const is_simulator = std.mem.indexOf(u8, ios_target_name, "simulator") != null;

    const ios_sdk = b.option([]const u8, "ios-sdk", "iOS SDK sysroot override") orelse iosSdkPath(b, if (is_simulator) "iphonesimulator" else "iphoneos");
    const ios_target = b.resolveTargetQuery(ios_query);

    const patch_root = b.addWriteFile(b.pathJoin(&.{ zero_native_path, "src/no_embed_root.zig" }), @embedFile("vendor/no_embed_root.zig"));

    const ios_zk_options = b.addOptions();
    ios_zk_options.addOption([]const u8, "repo_root", repo_root);
    ios_zk_options.addOption(bool, "is_ios", true);
    ios_zk_options.addOption(bool, "zk_link_static", true);
    const ios_zk_options_mod = ios_zk_options.createModule();

    const ios_zero_native_mod = zeroNativeModule(b, ios_target, optimize, zero_native_path);
    const ios_main_thread_mod = localModule(b, ios_target, optimize, "src/main_thread_dispatch.zig");
    const ios_zk_bridge_mod = localModule(b, ios_target, optimize, "src/zk_bridge.zig");
    ios_zk_bridge_mod.addImport("zero-native", ios_zero_native_mod);
    ios_zk_bridge_mod.addImport("build_options", ios_zk_options_mod);
    const ios_zkey_store_mod = b.createModule(.{
        .root_source_file = b.path("../libzkcasino/src/zig/prove/zkey_store.zig"),
        .target = ios_target,
        .optimize = optimize,
        .link_libc = true,
    });
    ios_zk_bridge_mod.addImport("zkey_store", ios_zkey_store_mod);
    ios_zk_bridge_mod.addImport("main_thread_dispatch", ios_main_thread_mod);

    const ios_player_bridge_mod = localModule(b, ios_target, optimize, "src/player_bridge.zig");
    ios_player_bridge_mod.addImport("zero-native", ios_zero_native_mod);
    ios_player_bridge_mod.addImport("build_options", ios_zk_options_mod);
    ios_player_bridge_mod.addImport("zk_bridge", ios_zk_bridge_mod);
    ios_player_bridge_mod.addImport("main_thread_dispatch", ios_main_thread_mod);
    const ios_player_crypto_mod = b.createModule(.{
        .root_source_file = b.path("../libzkcasino/src/zig/player_crypto.zig"),
        .target = ios_target,
        .optimize = optimize,
        .link_libc = true,
    });
    ios_player_crypto_mod.addImport("zkey_store", ios_zkey_store_mod);
    ios_player_bridge_mod.addImport("player_crypto", ios_player_crypto_mod);
    ios_player_bridge_mod.link_libc = true;

    const ios_server_bridge_mod = localModule(b, ios_target, optimize, "src/server_bridge.zig");
    ios_server_bridge_mod.addImport("zero-native", ios_zero_native_mod);
    ios_server_bridge_mod.addImport("build_options", ios_zk_options_mod);

    const ios_solana_bridge_mod = localModule(b, ios_target, optimize, "src/solana_bridge.zig");
    ios_solana_bridge_mod.addImport("zero-native", ios_zero_native_mod);
    ios_solana_bridge_mod.addImport("build_options", ios_zk_options_mod);

    const ios_launch_config_bridge_mod = localModule(b, ios_target, optimize, "src/launch_config_bridge.zig");
    ios_launch_config_bridge_mod.addImport("zero-native", ios_zero_native_mod);

    const ios_app_core_mod = localModule(b, ios_target, optimize, "src/app_core.zig");
    ios_app_core_mod.addImport("zero-native", ios_zero_native_mod);
    ios_app_core_mod.addImport("zk_bridge", ios_zk_bridge_mod);
    ios_app_core_mod.addImport("player_bridge", ios_player_bridge_mod);
    ios_app_core_mod.addImport("server_bridge", ios_server_bridge_mod);
    ios_app_core_mod.addImport("launch_config_bridge", ios_launch_config_bridge_mod);
    ios_app_core_mod.addImport("solana_bridge", ios_solana_bridge_mod);

    const ios_embed_mod = localModule(b, ios_target, optimize, "src/ios_embed.zig");
    ios_embed_mod.addImport("zero-native", ios_zero_native_mod);
    ios_embed_mod.addImport("app_core", ios_app_core_mod);

    const ios_lib = b.addLibrary(.{
        .linkage = .static,
        .name = "app",
        .root_module = ios_embed_mod,
    });
    ios_lib.root_module.link_libc = true;
    ios_lib.root_module.linkSystemLibrary("c++", .{});
    ios_lib.bundle_compiler_rt = true;
    linkIosRapidsnark(b, ios_lib, is_simulator);
    if (ios_sdk) |sdk| {
        linkIosDispatch(b, ios_lib, sdk);
        linkIosStubs(b, ios_lib, sdk);
    }
    ios_lib.step.dependOn(&patch_root.step);

    const install_ios_lib = b.addInstallArtifact(ios_lib, .{});
    const copy_header = b.addWriteFile("zig-out/include/zero_native.h", @embedFile("ios/ZeroNativeIOSExample/zero_native.h"));
    const copy_lib = b.addInstallFileWithDir(ios_lib.getEmittedBin(), .{ .custom = "../ios/Libraries" }, "libapp.a");
    copy_lib.step.dependOn(&ios_lib.step);

    const ios_lib_step = b.step("ios-lib", "Build iOS embedded static library for Swift host");
    ios_lib_step.dependOn(&install_ios_lib.step);
    ios_lib_step.dependOn(&copy_header.step);
    ios_lib_step.dependOn(&copy_lib.step);
}

fn zeroNativeModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, zero_native_path: []const u8) *std.Build.Module {
    const geometry_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/geometry/root.zig");
    const assets_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/assets/root.zig");
    const app_dirs_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/app_dirs/root.zig");
    const trace_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/trace/root.zig");
    const app_manifest_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/app_manifest/root.zig");
    const diagnostics_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/diagnostics/root.zig");
    const platform_info_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/platform_info/root.zig");
    const json_mod = externalModule(b, target, optimize, zero_native_path, "src/primitives/json/root.zig");
    const debug_mod = externalModule(b, target, optimize, zero_native_path, "src/debug/root.zig");
    debug_mod.addImport("app_dirs", app_dirs_mod);
    debug_mod.addImport("trace", trace_mod);

    const zero_native_mod = externalModule(b, target, optimize, zero_native_path, "src/no_embed_root.zig");
    zero_native_mod.addImport("geometry", geometry_mod);
    zero_native_mod.addImport("assets", assets_mod);
    zero_native_mod.addImport("app_dirs", app_dirs_mod);
    zero_native_mod.addImport("trace", trace_mod);
    zero_native_mod.addImport("app_manifest", app_manifest_mod);
    zero_native_mod.addImport("diagnostics", diagnostics_mod);
    zero_native_mod.addImport("platform_info", platform_info_mod);
    zero_native_mod.addImport("json", json_mod);
    return zero_native_mod;
}

fn linkIosRapidsnark(b: *std.Build, ios_lib: *std.Build.Step.Compile, is_simulator: bool) void {
    const prefix = if (is_simulator)
        "../rapidsnark/lib/ios-simulator/lib/"
    else
        "../rapidsnark/lib/ios-device/lib/";
    const rapidsnark = b.fmt("{s}librapidsnark.a", .{prefix});
    const fr = b.fmt("{s}libfr.a", .{prefix});
    const fq = b.fmt("{s}libfq.a", .{prefix});
    const gmp = b.fmt("{s}libgmp.a", .{prefix});
    ios_lib.root_module.addObjectFile(b.path(rapidsnark));
    ios_lib.root_module.addObjectFile(b.path(fr));
    ios_lib.root_module.addObjectFile(b.path(fq));
    ios_lib.root_module.addObjectFile(b.path(gmp));
}


fn linkIosDispatch(b: *std.Build, ios_lib: *std.Build.Step.Compile, sdk: []const u8) void {
    const sdk_include = b.pathJoin(&.{ sdk, "usr/include" });
    const flags = &[_][]const u8{ "-fobjc-arc", "-ObjC", "-isysroot", sdk, "-I", sdk_include };
    ios_lib.root_module.addCSourceFile(.{ .file = b.path("src/main_thread_dispatch.m"), .flags = flags });
}

fn linkIosStubs(b: *std.Build, ios_lib: *std.Build.Step.Compile, sdk: []const u8) void {
    const flags = &[_][]const u8{ "-isysroot", sdk };
    ios_lib.root_module.addCSourceFile(.{ .file = b.path("src/ios_link_stubs.c"), .flags = flags });
}

fn iosSdkPath(b: *std.Build, sdk: []const u8) ?[]const u8 {
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

fn repoRootPath(b: *std.Build) ?[]const u8 {
    const result = std.process.run(b.allocator, b.graph.io, .{
        .argv = &.{ "python3", "-c", "import os; print(os.path.realpath(os.path.join(os.getcwd(), '..')))" },
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

fn localModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, path: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path(path),
        .target = target,
        .optimize = optimize,
    });
}

fn externalModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode, zero_native_path: []const u8, path: []const u8) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = .{ .cwd_relative = b.pathJoin(&.{ zero_native_path, path }) },
        .target = target,
        .optimize = optimize,
    });
}
