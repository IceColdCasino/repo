pub const BINGO_75_SHOE: usize = 75;
pub const BINGO_90_SHOE: usize = 90;
pub const BINGO_75_CELLS: usize = 25;
pub const BINGO_90_CELLS: usize = 27;

pub fn packTerm(won: bool, completion: u32) u32 {
    return (if (won) @as(u32, 1) else 0) * 256 + completion;
}

fn mark75(cells: []const u8, called: []const u8, marked: *[25]bool) void {
    @memset(marked, false);
    for (cells, 0..) |cell, i| {
        if (i == 12 or cell == 0) marked[i] = true;
    }
    var drawn = [_]bool{false} ** 76;
    for (called) |b| drawn[b + 1] = true;
    for (cells, 0..) |cell, i| {
        if (cell != 0 and drawn[cell]) marked[i] = true;
    }
}

fn anyLine75(m: *const [25]bool) bool {
    var r: usize = 0;
    while (r < 5) : (r += 1) {
        if (m[r * 5] and m[r * 5 + 1] and m[r * 5 + 2] and m[r * 5 + 3] and m[r * 5 + 4]) return true;
    }
    var c: usize = 0;
    while (c < 5) : (c += 1) {
        if (m[c] and m[5 + c] and m[10 + c] and m[15 + c] and m[20 + c]) return true;
    }
    if (m[0] and m[6] and m[12] and m[18] and m[24]) return true;
    if (m[4] and m[8] and m[12] and m[16] and m[20]) return true;
    return false;
}

fn patternHit75(m: *const [25]bool, pattern_id: u32) bool {
    if (pattern_id == 1) return m[0] and m[4] and m[20] and m[24];
    if (pattern_id == 2) {
        for (m) |v| {
            if (!v) return false;
        }
        return true;
    }
    return anyLine75(m);
}

pub fn evaluate75(cells: []const u8, balls: []const u8, n_called: usize, pattern_id: u32) struct { won: bool, completion: u32, packed_term: u32 } {
    var t: usize = 0;
    while (t < n_called) : (t += 1) {
        var marked: [25]bool = undefined;
        mark75(cells, balls[0 .. t + 1], &marked);
        if (patternHit75(&marked, pattern_id)) {
            const completion: u32 = @intCast(t + 1);
            return .{ .won = true, .completion = completion, .packed_term = packTerm(true, completion) };
        }
    }
    return .{ .won = false, .completion = 0, .packed_term = packTerm(false, 0) };
}

fn mark90(cells: []const u8, called: []const u8, marked: *[27]bool) void {
    var drawn = [_]bool{false} ** 91;
    for (called) |b| drawn[b + 1] = true;
    for (cells, 0..) |cell, i| {
        marked[i] = cell != 0 and drawn[cell];
    }
}

fn completedRows90(cells: []const u8, marked: *const [27]bool) u32 {
    var rows: u32 = 0;
    var r: usize = 0;
    while (r < 3) : (r += 1) {
        var need: u32 = 0;
        var got: u32 = 0;
        var c: usize = 0;
        while (c < 9) : (c += 1) {
            const i = r * 9 + c;
            if (cells[i] != 0) {
                need += 1;
                if (marked[i]) got += 1;
            }
        }
        if (need == 5 and got == 5) rows += 1;
    }
    return rows;
}

pub const Bingo90 = struct {
    one_line: u32,
    two_lines: u32,
    full_house: u32,
};

pub fn evaluate90(cells: []const u8, balls: []const u8, n_called: usize) Bingo90 {
    const term = struct {
        fn run(need: u32, cells_: []const u8, balls_: []const u8, n_called_: usize) u32 {
            var t: usize = 0;
            while (t < n_called_) : (t += 1) {
                var marked: [27]bool = undefined;
                mark90(cells_, balls_[0 .. t + 1], &marked);
                if (completedRows90(cells_, &marked) >= need) return packTerm(true, @intCast(t + 1));
            }
            return packTerm(false, 0);
        }
    };
    return .{
        .one_line = term.run(1, cells, balls, n_called),
        .two_lines = term.run(2, cells, balls, n_called),
        .full_house = term.run(3, cells, balls, n_called),
    };
}

pub fn sample75(salt: u8, out: *[25]u8) void {
    const lo = [_]u8{ 1, 16, 31, 46, 61 };
    @memset(out, 0);
    var col: u8 = 0;
    while (col < 5) : (col += 1) {
        var row: u8 = 0;
        while (row < 5) : (row += 1) {
            const i = row * 5 + col;
            if (i == 12) continue;
            out[i] = lo[col] + ((row + salt) % 15);
        }
    }
}
