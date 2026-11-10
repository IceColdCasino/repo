#include "circom.hpp"
#include "calcwit.hpp"

// Compiled only into the wide shared library, with the same prefix header as
// the generated circuit. SIMD_RUN_NAME is the renamed C++ `run`.
#ifndef SIMD_RUN_NAME
#define SIMD_RUN_NAME run_simd
#endif

#define simd_entry2(name) name##_entry
#define simd_entry(name) simd_entry2(name)

extern void SIMD_RUN_NAME(Circom_CalcWit* ctx);

extern "C" __attribute__((visibility("default"))) void simd_entry(SIMD_RUN_NAME)(Circom_CalcWit* ctx) {
    SIMD_RUN_NAME(ctx);
}
