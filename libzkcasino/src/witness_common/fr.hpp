#ifndef FR_HPP
#define FR_HPP

#include <cstdint>
#include <cstddef>

using FrElement = uint64_t[4];
using PFrElement = FrElement*;

void Fr_add(PFrElement r, PFrElement a, PFrElement b);
void Fr_sub(PFrElement r, PFrElement a, PFrElement b);
void Fr_neg(PFrElement r, PFrElement a);
void Fr_mul(PFrElement r, PFrElement a, PFrElement b);
void Fr_sqr(PFrElement r, PFrElement a);
void Fr_div(PFrElement r, PFrElement a, PFrElement b);
void Fr_inv(PFrElement r, PFrElement a);
void Fr_copy(PFrElement dst, PFrElement src);
void Fr_copyn(PFrElement dst, PFrElement src, size_t n);
void Fr_eq(PFrElement result, PFrElement a, PFrElement b);
void Fr_neq(PFrElement result, PFrElement a, PFrElement b);
int Fr_isTrue(PFrElement a);
int Fr_isZero(PFrElement a);
void Fr_lt(PFrElement result, PFrElement a, PFrElement b);
uint64_t Fr_toInt(PFrElement a);
int Fr_cmp(PFrElement a, PFrElement b);
void Fr_shr(PFrElement r, PFrElement a, PFrElement b);
void Fr_shl(PFrElement r, PFrElement a, PFrElement b);
void Fr_band(PFrElement r, PFrElement a, PFrElement b);
void Fr_bor(PFrElement r, PFrElement a, PFrElement b);
void Fr_bxor(PFrElement r, PFrElement a, PFrElement b);
void Fr_not(PFrElement r, PFrElement a);
void Fr_gt(PFrElement r, PFrElement a, PFrElement b);
void Fr_idiv(PFrElement r, PFrElement a, PFrElement b);
void Fr_land(PFrElement r, PFrElement a, PFrElement b);
void Fr_lor(PFrElement r, PFrElement a, PFrElement b);
void Fr_lnot(PFrElement r, PFrElement a);
void Fr_leq(PFrElement r, PFrElement a, PFrElement b);
void Fr_geq(PFrElement r, PFrElement a, PFrElement b);
void Fr_mod(PFrElement r, PFrElement a, PFrElement b);

#endif
