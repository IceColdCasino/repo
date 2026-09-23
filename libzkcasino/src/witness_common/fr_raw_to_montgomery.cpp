#include <cstdint>

// rapidsnark declares this with C++ linkage. On macOS uint64_t is
// unsigned long long; on Linux it is unsigned long, so the Itanium
// mangling differs. Call it from C++ and export one C name for Zig.
typedef uint64_t FrRawElement[4];
void Fr_rawToMontgomery(FrRawElement result, const FrRawElement &value);

extern "C" void zkcasino_Fr_rawToMontgomery(uint64_t *dst, const uint64_t *src) {
    Fr_rawToMontgomery(dst, *reinterpret_cast<const FrRawElement *>(src));
}
