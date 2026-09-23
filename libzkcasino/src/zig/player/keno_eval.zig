pub const KENO_SHOE_SIZE: usize = 80;
pub const KENO_DRAW: usize = 20;
pub const MAX_KENO_SPOTS: usize = 20;

pub fn padSpots(spots: []const u8, out: *[MAX_KENO_SPOTS]u8) []const u8 {
    if (spots.len == MAX_KENO_SPOTS) {
        @memcpy(out, spots);
        return out;
    }
    var used = [_]bool{false} ** KENO_SHOE_SIZE;
    var n: usize = 0;
    for (spots) |s| {
        used[s] = true;
        out[n] = s;
        n += 1;
    }
    var i: u8 = 0;
    while (i < KENO_SHOE_SIZE and n < MAX_KENO_SPOTS) : (i += 1) {
        if (!used[i]) {
            out[n] = i;
            n += 1;
        }
    }
    return out[0..MAX_KENO_SPOTS];
}

pub fn evaluate(draw: []const u8, spots: []const u8, n_actual: usize) u32 {
    var drawn = [_]bool{false} ** KENO_SHOE_SIZE;
    for (draw) |d| drawn[d] = true;
    var matches: u32 = 0;
    var i: usize = 0;
    while (i < n_actual) : (i += 1) {
        if (drawn[spots[i]]) matches += 1;
    }
    return matches;
}
