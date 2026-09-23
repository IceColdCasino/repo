// C ABI aliases for fr_raw_generic.cpp / fr_raw_arm64.s symbols.
// Those are compiled as C++ (mangled names). Zig fr.zig imports extern "C"
// Fr_raw*, and iOS dylibs use -undefined dynamic_lookup — without these
// aliases the calls resolve to NULL and SIGSEGV in Fr_toLongNormal.

#include <cstdint>

using FrRawElement = uint64_t[4];
using Raw = uint64_t *;
using ConstRaw = const uint64_t *;

// Bind to Itanium-mangled C++ symbols from libfr.
extern void cxx_Fr_rawAdd(Raw, ConstRaw, ConstRaw) asm("__Z9Fr_rawAddPyPKyS1_");
extern void cxx_Fr_rawSub(Raw, ConstRaw, ConstRaw) asm("__Z9Fr_rawSubPyPKyS1_");
extern void cxx_Fr_rawNeg(Raw, ConstRaw) asm("__Z9Fr_rawNegPyPKy");
extern void cxx_Fr_rawMMul(Raw, ConstRaw, ConstRaw) asm("__Z10Fr_rawMMulPyPKyS1_");
extern void cxx_Fr_rawMMul1(Raw, ConstRaw, uint64_t) asm("__Z11Fr_rawMMul1PyPKyy");
extern void cxx_Fr_rawFromMontgomery(Raw, const uint64_t(*)[4]) asm("__Z20Fr_rawFromMontgomeryPyRA4_Ky");
extern void cxx_Fr_rawCopy(Raw, ConstRaw) asm("__Z10Fr_rawCopyPyPKy");
extern void cxx_Fr_rawSwap(Raw, Raw) asm("__Z10Fr_rawSwapPyS_");
extern int cxx_Fr_rawIsEq(ConstRaw, ConstRaw) asm("__Z10Fr_rawIsEqPKyS0_");
extern int cxx_Fr_rawIsZero(ConstRaw) asm("__Z12Fr_rawIsZeroPKy");
extern void cxx_Fr_rawAnd(Raw, Raw, Raw) asm("__Z9Fr_rawAndPyS_S_");
extern void cxx_Fr_rawOr(Raw, Raw, Raw) asm("__Z8Fr_rawOrPyS_S_");
extern void cxx_Fr_rawXor(Raw, Raw, Raw) asm("__Z9Fr_rawXorPyS_S_");
extern void cxx_Fr_rawNot(Raw, Raw) asm("__Z9Fr_rawNotPyS_");
extern void cxx_Fr_rawShl(Raw, Raw, uint64_t) asm("__Z9Fr_rawShlPyS_y");
extern void cxx_Fr_rawShr(Raw, Raw, uint64_t) asm("__Z9Fr_rawShrPyS_y");
extern int cxx_Fr_rawCmp(Raw, Raw) asm("__Z9Fr_rawCmpPyS_");

// Fr_rawToMontgomery's C++ mangling differs by platform. Zig calls
// zkcasino_Fr_rawToMontgomery from fr_raw_to_montgomery.cpp.

extern "C" {

void Fr_rawAdd(FrRawElement r, const FrRawElement a, const FrRawElement b) {
    cxx_Fr_rawAdd(r, a, b);
}
void Fr_rawSub(FrRawElement r, const FrRawElement a, const FrRawElement b) {
    cxx_Fr_rawSub(r, a, b);
}
void Fr_rawNeg(FrRawElement r, const FrRawElement a) {
    cxx_Fr_rawNeg(r, a);
}
void Fr_rawMMul(FrRawElement r, const FrRawElement a, const FrRawElement b) {
    cxx_Fr_rawMMul(r, a, b);
}
void Fr_rawMMul1(FrRawElement r, const FrRawElement a, uint64_t b) {
    cxx_Fr_rawMMul1(r, a, b);
}
void Fr_rawFromMontgomery(FrRawElement r, const FrRawElement a) {
    cxx_Fr_rawFromMontgomery(r, reinterpret_cast<const uint64_t(*)[4]>(a));
}
void Fr_rawCopy(FrRawElement r, const FrRawElement a) {
    cxx_Fr_rawCopy(r, a);
}
void Fr_rawSwap(FrRawElement r, FrRawElement a) {
    cxx_Fr_rawSwap(r, a);
}
int Fr_rawIsEq(const FrRawElement a, const FrRawElement b) {
    return cxx_Fr_rawIsEq(a, b);
}
int Fr_rawIsZero(const FrRawElement a) {
    return cxx_Fr_rawIsZero(a);
}
void Fr_rawAnd(FrRawElement r, FrRawElement a, FrRawElement b) {
    cxx_Fr_rawAnd(r, a, b);
}
void Fr_rawOr(FrRawElement r, FrRawElement a, FrRawElement b) {
    cxx_Fr_rawOr(r, a, b);
}
void Fr_rawXor(FrRawElement r, FrRawElement a, FrRawElement b) {
    cxx_Fr_rawXor(r, a, b);
}
void Fr_rawNot(FrRawElement r, FrRawElement a) {
    cxx_Fr_rawNot(r, a);
}
void Fr_rawShl(FrRawElement r, FrRawElement a, uint64_t n) {
    cxx_Fr_rawShl(r, a, n);
}
void Fr_rawShr(FrRawElement r, FrRawElement a, uint64_t n) {
    cxx_Fr_rawShr(r, a, n);
}
int Fr_rawCmp(FrRawElement a, FrRawElement b) {
    return cxx_Fr_rawCmp(a, b);
}

} // extern "C"
