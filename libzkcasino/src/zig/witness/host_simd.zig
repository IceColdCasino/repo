//! Runtime SIMD probe for Linux amd64 and arm64.
//! The portable witness is always linked. The wide copy is used only when
//! every instruction it was compiled with is legal on this CPU.
const builtin = @import("builtin");
const std = @import("std");

pub fn fast() bool {
    if (comptime !(builtin.os.tag == .linux)) return false;
    return switch (comptime builtin.cpu.arch) {
        .x86_64 => x86V3(),
        .aarch64 => armV82(),
        else => false,
    };
}

export fn zkcasino_host_simd_fast() c_int {
    return if (fast()) 1 else 0;
}

fn x86V3() bool {
    if (comptime !(builtin.os.tag == .linux and builtin.cpu.arch == .x86_64)) return false;
    const leaf1 = cpuid(1, 0);
    const ecx = leaf1[2];
    const has = struct {
        fn bit(value: u32, n: u5) bool {
            return (value & (@as(u32, 1) << n)) != 0;
        }
    };
    // x86-64-v3, plus OSXSAVE/XCR0 so AVX state is actually enabled.
    if (!has.bit(ecx, 0)) return false; // sse3
    if (!has.bit(ecx, 9)) return false; // ssse3
    if (!has.bit(ecx, 12)) return false; // fma
    if (!has.bit(ecx, 13)) return false; // cx16
    if (!has.bit(ecx, 19)) return false; // sse4.1
    if (!has.bit(ecx, 20)) return false; // sse4.2
    if (!has.bit(ecx, 22)) return false; // movbe
    if (!has.bit(ecx, 23)) return false; // popcnt
    if (!has.bit(ecx, 27)) return false; // osxsave
    if (!has.bit(ecx, 28)) return false; // avx
    if (!has.bit(ecx, 29)) return false; // f16c
    const leaf7 = cpuid(7, 0);
    const ebx = leaf7[1];
    if (!has.bit(ebx, 3)) return false; // bmi
    if (!has.bit(ebx, 5)) return false; // avx2
    if (!has.bit(ebx, 8)) return false; // bmi2
    const ext = cpuid(0x80000001, 0);
    if (!has.bit(ext[2], 0)) return false; // lahf
    if (!has.bit(ext[2], 5)) return false; // lzcnt
    const xcr = xgetbv0();
    // XMM and YMM, bits 1 and 2.
    return (xcr & 0x6) == 0x6;
}

fn armV82() bool {
    if (comptime !(builtin.os.tag == .linux and builtin.cpu.arch == .aarch64)) return false;
    const hwcap = std.os.linux.getauxval(std.elf.AT.HWCAP);
    const asimd: usize = 1 << 1;
    const crc32: usize = 1 << 7;
    const atomics: usize = 1 << 8;
    const asimddp: usize = 1 << 20;
    const need = asimd | crc32 | atomics | asimddp;
    return (hwcap & need) == need;
}

fn cpuid(leaf: u32, subleaf: u32) [4]u32 {
    var eax: u32 = leaf;
    var ebx: u32 = 0;
    var ecx: u32 = subleaf;
    var edx: u32 = 0;
    asm volatile ("cpuid"
        : [eax] "={eax}" (eax),
          [ebx] "={ebx}" (ebx),
          [ecx] "={ecx}" (ecx),
          [edx] "={edx}" (edx),
        : [leaf] "{eax}" (eax),
          [sub] "{ecx}" (ecx),
    );
    return .{ eax, ebx, ecx, edx };
}

fn xgetbv0() u64 {
    var eax: u32 = undefined;
    var edx: u32 = undefined;
    asm volatile ("xgetbv"
        : [eax] "={eax}" (eax),
          [edx] "={edx}" (edx),
        : [ecx] "{ecx}" (@as(u32, 0)),
    );
    return (@as(u64, edx) << 32) | eax;
}

test "simd probe is false off linux" {
    if (comptime builtin.os.tag != .linux) {
        try std.testing.expect(!fast());
    }
}
