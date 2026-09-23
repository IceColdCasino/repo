//! circomlib optimized Poseidon over BN254 Fr (matches buildPoseidon / Poseidon.circom).
const std = @import("std");
const Fr = @import("fr.zig").Fr;
const simd = @import("fr_simd.zig");
const cnst = @import("poseidon_constants.zig");

const N_ROUNDS_F: u32 = cnst.N_ROUNDS_F;

fn nRoundsP(t: usize) u32 {
    return cnst.N_ROUNDS_P[t - 2];
}

fn C(t: usize, i: usize) Fr {
    return Fr.fromNormal(switch (t) {
        2 => cnst.C_2[i],
        3 => cnst.C_3[i],
        4 => cnst.C_4[i],
        5 => cnst.C_5[i],
        6 => cnst.C_6[i],
        7 => cnst.C_7[i],
        8 => cnst.C_8[i],
        9 => cnst.C_9[i],
        10 => cnst.C_10[i],
        11 => cnst.C_11[i],
        12 => cnst.C_12[i],
        13 => cnst.C_13[i],
        14 => cnst.C_14[i],
        15 => cnst.C_15[i],
        16 => cnst.C_16[i],
        17 => cnst.C_17[i],
        else => unreachable,
    });
}

fn S(t: usize, i: usize) Fr {
    return Fr.fromNormal(switch (t) {
        2 => cnst.S_2[i],
        3 => cnst.S_3[i],
        4 => cnst.S_4[i],
        5 => cnst.S_5[i],
        6 => cnst.S_6[i],
        7 => cnst.S_7[i],
        8 => cnst.S_8[i],
        9 => cnst.S_9[i],
        10 => cnst.S_10[i],
        11 => cnst.S_11[i],
        12 => cnst.S_12[i],
        13 => cnst.S_13[i],
        14 => cnst.S_14[i],
        15 => cnst.S_15[i],
        16 => cnst.S_16[i],
        17 => cnst.S_17[i],
        else => unreachable,
    });
}

fn M(t: usize, j: usize, i: usize) Fr {
    return Fr.fromNormal(switch (t) {
        2 => cnst.M_2[j][i],
        3 => cnst.M_3[j][i],
        4 => cnst.M_4[j][i],
        5 => cnst.M_5[j][i],
        6 => cnst.M_6[j][i],
        7 => cnst.M_7[j][i],
        8 => cnst.M_8[j][i],
        9 => cnst.M_9[j][i],
        10 => cnst.M_10[j][i],
        11 => cnst.M_11[j][i],
        12 => cnst.M_12[j][i],
        13 => cnst.M_13[j][i],
        14 => cnst.M_14[j][i],
        15 => cnst.M_15[j][i],
        16 => cnst.M_16[j][i],
        17 => cnst.M_17[j][i],
        else => unreachable,
    });
}

fn P(t: usize, j: usize, i: usize) Fr {
    return Fr.fromNormal(switch (t) {
        2 => cnst.P_2[j][i],
        3 => cnst.P_3[j][i],
        4 => cnst.P_4[j][i],
        5 => cnst.P_5[j][i],
        6 => cnst.P_6[j][i],
        7 => cnst.P_7[j][i],
        8 => cnst.P_8[j][i],
        9 => cnst.P_9[j][i],
        10 => cnst.P_10[j][i],
        11 => cnst.P_11[j][i],
        12 => cnst.P_12[j][i],
        13 => cnst.P_13[j][i],
        14 => cnst.P_14[j][i],
        15 => cnst.P_15[j][i],
        16 => cnst.P_16[j][i],
        17 => cnst.P_17[j][i],
        else => unreachable,
    });
}

fn mixM(t: usize, state: []Fr) void {
    mixGeneric(t, state, M);
}

fn mixP(t: usize, state: []Fr) void {
    mixGeneric(t, state, P);
}

fn mixGeneric(t: usize, state: []Fr, comptime coeff: fn (usize, usize, usize) Fr) void {
    var out: [17]Fr = undefined;
    var i: usize = 0;
    while (i + simd.LANES <= t) : (i += simd.LANES) {
        var rows: [17]simd.Fr4 = undefined;
        var j: usize = 0;
        while (j < t) : (j += 1) {
            rows[j] = .{
                coeff(t, j, i),
                coeff(t, j, i + 1),
                coeff(t, j, i + 2),
                coeff(t, j, i + 3),
            };
        }
        const acc = simd.dot4(state[0..t], rows[0..t]);
        inline for (0..simd.LANES) |lane| out[i + lane] = acc[lane];
    }
    while (i < t) : (i += 1) {
        var acc = Fr.zero();
        var j: usize = 0;
        while (j < t) : (j += 1) {
            acc = acc.add(coeff(t, j, i).mul(state[j]));
        }
        out[i] = acc;
    }
    @memcpy(state[0..t], out[0..t]);
}

/// Poseidon(inputs) with initState=0, nOut=1. `inputs.len` in 1..16.
pub fn hash(inputs: []const Fr) Fr {
    std.debug.assert(inputs.len >= 1 and inputs.len <= 16);
    const t = inputs.len + 1;
    const nP = nRoundsP(t);
    var state_buf: [17]Fr = undefined;
    const state = state_buf[0..t];
    state[0] = Fr.zero();
    @memcpy(state[1..], inputs);

    var i: usize = 0;
    while (i < t) : (i += 1) {
        state[i] = state[i].add(C(t, i));
    }

    var r: u32 = 0;
    while (r < N_ROUNDS_F / 2 - 1) : (r += 1) {
        i = 0;
        while (i < t) : (i += 1) {
            state[i] = state[i].pow5().add(C(t, @as(usize, r + 1) * t + i));
        }
        mixM(t, state);
    }
    i = 0;
    while (i < t) : (i += 1) {
        state[i] = state[i].pow5().add(C(t, (N_ROUNDS_F / 2) * t + i));
    }
    mixP(t, state);

    r = 0;
    while (r < nP) : (r += 1) {
        state[0] = state[0].pow5().add(C(t, (N_ROUNDS_F / 2 + 1) * t + r));
        var s0 = Fr.zero();
        i = 0;
        while (i < t) : (i += 1) {
            s0 = s0.add(S(t, @as(usize, (t * 2 - 1) * r + i)).mul(state[i]));
        }
        i = 1;
        while (i < t) : (i += 1) {
            state[i] = state[i].add(state[0].mul(S(t, (t * 2 - 1) * r + t + i - 1)));
        }
        state[0] = s0;
    }

    r = 0;
    while (r < N_ROUNDS_F / 2 - 1) : (r += 1) {
        i = 0;
        while (i < t) : (i += 1) {
            state[i] = state[i].pow5().add(C(t, (N_ROUNDS_F / 2 + 1) * t + nP + @as(usize, r) * t + i));
        }
        mixM(t, state);
    }
    i = 0;
    while (i < t) : (i += 1) {
        state[i] = state[i].pow5();
    }
    mixM(t, state);
    return state[0];
}

pub fn hashBigints(values: []const u64) Fr {
    var buf: [16]Fr = undefined;
    for (values, 0..) |v, i| buf[i] = Fr.fromU64(v);
    return hash(buf[0..values.len]);
}

/// Four independent Poseidon hashes of the same arity (SIMD-batched libfr lanes).
pub fn hash4(inputs: [4][]const Fr) [4]Fr {
    return .{ hash(inputs[0]), hash(inputs[1]), hash(inputs[2]), hash(inputs[3]) };
}

/// Convenience: hash 4 independent 12-input vectors using 4-lane mul/add.
pub fn hash12x4(rows: [4][12]Fr) [4]Fr {
    var slices: [4][]const Fr = undefined;
    var storage = rows;
    inline for (0..4) |i| slices[i] = storage[i][0..];
    _ = simd.LANES;
    return hash4(slices);
}
