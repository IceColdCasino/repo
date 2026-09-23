//! 4-lane batched Fr ops. Each lane calls libfr (ARM64 Montgomery).
const fr_mod = @import("fr.zig");
pub const Fr = fr_mod.Fr;

pub const LANES = 4;
pub const Fr4 = [LANES]Fr;

pub fn splat(v: Fr) Fr4 {
    return .{ v, v, v, v };
}

pub fn add4(a: Fr4, b: Fr4) Fr4 {
    return .{ a[0].add(b[0]), a[1].add(b[1]), a[2].add(b[2]), a[3].add(b[3]) };
}

pub fn sub4(a: Fr4, b: Fr4) Fr4 {
    return .{ a[0].sub(b[0]), a[1].sub(b[1]), a[2].sub(b[2]), a[3].sub(b[3]) };
}

pub fn mul4(a: Fr4, b: Fr4) Fr4 {
    return .{ a[0].mul(b[0]), a[1].mul(b[1]), a[2].mul(b[2]), a[3].mul(b[3]) };
}

pub fn square4(a: Fr4) Fr4 {
    return .{ a[0].square(), a[1].square(), a[2].square(), a[3].square() };
}

pub fn pow5_4(a: Fr4) Fr4 {
    return .{ a[0].pow5(), a[1].pow5(), a[2].pow5(), a[3].pow5() };
}

pub fn inv4(a: Fr4) Fr4 {
    return .{ a[0].inv(), a[1].inv(), a[2].inv(), a[3].inv() };
}

/// Horner / MDS dot: out[lane] = sum_j coeffs[j] * rows[j][lane]
pub fn dot4(coeffs: []const Fr, rows: []const Fr4) Fr4 {
    var acc = splat(Fr.zero());
    for (coeffs, rows) |c, row| {
        acc = add4(acc, mul4(splat(c), row));
    }
    return acc;
}
