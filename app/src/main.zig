const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");
const app_core = @import("app_core");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

pub fn main(init: std.process.Init) !void {
    var app = try app_core.App.initDesktop(init.io, init.environ_map);
    defer app.deinit(std.heap.page_allocator);
    try runner.runWithOptions(app.runtimeApp(), .{
        .app_name = "App",
        .window_title = "App",
        .bundle_id = "dev.zero_native.app",
        .icon_path = "assets/icon.icns",
        .bridge = app.bridge(),
        .security = .{
            .navigation = .{ .allowed_origins = &app_core.dev_origins },
        },
    }, init);
}

test "app name is configured" {
    try std.testing.expectEqualStrings("app", "app");
}
