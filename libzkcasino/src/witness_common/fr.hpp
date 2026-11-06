#ifndef FR_HPP
#define FR_HPP

#include <cstdint>
#include <cstddef>

struct FrElement {
    int32_t shortVal;
    uint32_t type;
    uint64_t longVal[4];
};

using PFrElement = FrElement*;

// Hot ops are inlined into the generated witness. Division stays in Zig.
extern "C" {

void Fr_div(PFrElement r, PFrElement a, PFrElement b);
void Fr_inv(PFrElement r, PFrElement a);
void Fr_idiv(PFrElement r, PFrElement a, PFrElement b);
void Fr_mod(PFrElement r, PFrElement a, PFrElement b);

#include "fr_inline.hpp"

}

#endif
