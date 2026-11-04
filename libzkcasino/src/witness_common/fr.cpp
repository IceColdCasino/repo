#include "fr.hpp"
#include <cstring>

// BN254 curve order Q (little-endian limbs)
// Q = 0x30644e72e131a029 * 2^256 + 0x43e1f593f0000001
static const FrElement Q_LIMBS = {
    {0, 0, {0x43e1f593f0000001ULL, 0x2833e84879b97091ULL, 0xb85045b68181585dULL, 0x30644e72e131a029ULL}}
};

// Helper to get limb pointer from FrElement
static inline uint64_t* limbs(PFrElement e) {
    return e->longVal;
}

// Modular addition: r = (a + b) mod Q
void Fr_add(PFrElement r, PFrElement a, PFrElement b) {
    unsigned __int128 carry = 0;
    for (int i = 0; i < 4; i++) {
        unsigned __int128 sum = (unsigned __int128)(*a).longVal[i] + (unsigned __int128)(*b).longVal[i] + carry;
        (*r).longVal[i] = (uint64_t)sum;
        carry = sum >> 64;
    }
    int cmp = 0;
    for (int i = 3; i >= 0; i--) {
        if ((*r).longVal[i] < Q_LIMBS.longVal[i]) { cmp = -1; break; }
        if ((*r).longVal[i] > Q_LIMBS.longVal[i]) { cmp = 1; break; }
    }
    if (cmp >= 0) {
        unsigned __int128 borrow = 0;
        for (int i = 0; i < 4; i++) {
            unsigned __int128 diff = (unsigned __int128)(*r).longVal[i] - (unsigned __int128)Q_LIMBS.longVal[i] - borrow;
            (*r).longVal[i] = (uint64_t)diff;
            borrow = (diff >> 64) & 1;
        }
    }
}

// Modular subtraction: r = (a - b) mod Q
void Fr_sub(PFrElement r, PFrElement a, PFrElement b) {
    unsigned __int128 borrow = 0;
    for (int i = 0; i < 4; i++) {
        unsigned __int128 diff = (unsigned __int128)(*a).longVal[i] - (unsigned __int128)(*b).longVal[i] - borrow;
        (*r).longVal[i] = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
    }
    int cmp = 0;
    for (int i = 3; i >= 0; i--) {
        if ((*a).longVal[i] < (*b).longVal[i]) { cmp = -1; break; }
        if ((*a).longVal[i] > (*b).longVal[i]) { cmp = 1; break; }
    }
    if (cmp < 0) {
        unsigned __int128 carry = 0;
        for (int i = 0; i < 4; i++) {
            unsigned __int128 sum = (unsigned __int128)(*r).longVal[i] + (unsigned __int128)Q_LIMBS.longVal[i] + carry;
            (*r).longVal[i] = (uint64_t)sum;
            carry = sum >> 64;
        }
    }
}

// Modular negation: r = (-a) mod Q
void Fr_neg(PFrElement r, PFrElement a) {
    if ((*a).longVal[0] == 0 && (*a).longVal[1] == 0 && (*a).longVal[2] == 0 && (*a).longVal[3] == 0) {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        unsigned __int128 borrow = 1;
        for (int i = 0; i < 4; i++) {
            unsigned __int128 diff = (unsigned __int128)0 - (unsigned __int128)(*a).longVal[i] - borrow;
            (*r).longVal[i] = (uint64_t)diff;
            borrow = (diff >> 64) & 1;
        }
        int cmp = 0;
        for (int i = 3; i >= 0; i--) {
            if ((*r).longVal[i] < Q_LIMBS.longVal[i]) { cmp = -1; break; }
            if ((*r).longVal[i] > Q_LIMBS.longVal[i]) { cmp = 1; break; }
        }
        if (cmp < 0) {
            unsigned __int128 carry = 0;
            for (int i = 0; i < 4; i++) {
                unsigned __int128 sum = (unsigned __int128)(*r).longVal[i] + (unsigned __int128)Q_LIMBS.longVal[i] + carry;
                (*r).longVal[i] = (uint64_t)sum;
                carry = sum >> 64;
            }
        }
    }
}

// Modular multiplication: r = (a * b) mod Q
void Fr_mul(PFrElement r, PFrElement a, PFrElement b) {
    unsigned __int128 product[8] = {0};
    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 4; j++) {
            product[i + j] += (unsigned __int128)(*a).longVal[i] * (unsigned __int128)(*b).longVal[j];
        }
    }
    for (int i = 0; i < 7; i++) {
        product[i + 1] += product[i] >> 64;
        product[i] &= 0xFFFFFFFFFFFFFFFFULL;
    }
    FrElement result;
    for (int i = 0; i < 4; i++) result.longVal[i] = (uint64_t)product[i];
    int cmp = 0;
    for (int i = 3; i >= 0; i--) {
        if (result.longVal[i] < Q_LIMBS.longVal[i]) { cmp = -1; break; }
        if (result.longVal[i] > Q_LIMBS.longVal[i]) { cmp = 1; break; }
    }
    while (cmp >= 0) {
        unsigned __int128 borrow = 0;
        for (int i = 0; i < 4; i++) {
            unsigned __int128 diff = (unsigned __int128)result.longVal[i] - (unsigned __int128)Q_LIMBS.longVal[i] - borrow;
            result.longVal[i] = (uint64_t)diff;
            borrow = (diff >> 64) & 1;
        }
        cmp = 0;
        for (int i = 3; i >= 0; i--) {
            if (result.longVal[i] < Q_LIMBS.longVal[i]) { cmp = -1; break; }
            if (result.longVal[i] > Q_LIMBS.longVal[i]) { cmp = 1; break; }
        }
    }
    for (int i = 0; i < 4; i++) (*r).longVal[i] = result.longVal[i];
}

// Modular squaring: r = (a * a) mod Q
void Fr_sqr(PFrElement r, PFrElement a) {
    Fr_mul(r, a, a);
}

// Modular division: r = (a / b) mod Q = a * b^(q-2) mod Q
void Fr_div(PFrElement r, PFrElement a, PFrElement b) {
    FrElement inv_b;
    Fr_inv(&inv_b, b);
    Fr_mul(r, a, &inv_b);
}

// Modular inversion: r = a^(-1) mod Q using Fermat's little theorem: a^(q-2)
void Fr_inv(PFrElement r, PFrElement a) {
    FrElement result = {{0, 0, {1, 0, 0, 0}}};
    FrElement base;
    for (int i = 0; i < 4; i++) base.longVal[i] = (*a).longVal[i];
    FrElement exp = {{0, 0, {Q_LIMBS.longVal[0] - 2, Q_LIMBS.longVal[1], Q_LIMBS.longVal[2], Q_LIMBS.longVal[3]}}};
    for (int bit = 0; bit < 256; bit++) {
        int limb = bit / 64;
        int bitpos = bit % 64;
        if ((exp.longVal[limb] >> bitpos) & 1) {
            Fr_mul(&result, &result, &base);
        }
        Fr_mul(&base, &base, &base);
    }
    for (int i = 0; i < 4; i++) (*r).longVal[i] = result.longVal[i];
}

// Copy
void Fr_copy(PFrElement dst, PFrElement src) {
    std::memcpy(dst, src, sizeof(FrElement));
}

// Copy n elements
void Fr_copyn(PFrElement dst, PFrElement src, size_t n) {
    for (size_t i = 0; i < n; i++) {
        std::memcpy(&dst[i], &src[i], sizeof(FrElement));
    }
}

// Equality: result = (a == b) ? 1 : 0
void Fr_eq(PFrElement result, PFrElement a, PFrElement b) {
    if (std::memcmp(a, b, sizeof(FrElement)) == 0) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Not equal: result = (a != b) ? 1 : 0
void Fr_neq(PFrElement result, PFrElement a, PFrElement b) {
    if (std::memcmp(a, b, sizeof(FrElement)) == 0) {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Is true: return 1 if non-zero
int Fr_isTrue(PFrElement a) {
    for (int i = 0; i < 4; i++) {
        if ((*a).longVal[i] != 0) return 1;
    }
    return 0;
}

// Is zero: return 1 if zero
int Fr_isZero(PFrElement a) {
    return (*a).longVal[0] == 0 && (*a).longVal[1] == 0 && (*a).longVal[2] == 0 && (*a).longVal[3] == 0;
}

// Less than: result = (a < b) ? 1 : 0
void Fr_lt(PFrElement result, PFrElement a, PFrElement b) {
    int cmp = 0;
    for (int i = 3; i >= 0; i--) {
        if ((*a).longVal[i] < (*b).longVal[i]) { cmp = -1; break; }
        if ((*a).longVal[i] > (*b).longVal[i]) { cmp = 1; break; }
    }
    if (cmp < 0) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Convert to integer (return low limb)
uint64_t Fr_toInt(PFrElement a) {
    return (*a).longVal[0];
}

// Compare: return -1 if a < b, 0 if equal, 1 if a > b
int Fr_cmp(PFrElement a, PFrElement b) {
    for (int i = 3; i >= 0; i--) {
        if ((*a).longVal[i] < (*b).longVal[i]) return -1;
        if ((*a).longVal[i] > (*b).longVal[i]) return 1;
    }
    return 0;
}

// Bitwise shift right: r = a >> b (use low limb of b as shift count)
void Fr_shr(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t shift = (*b).longVal[0] % 256;
    if (shift >= 64) {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else if (shift == 0) {
        (*r).longVal[0] = (*a).longVal[0]; (*r).longVal[1] = (*a).longVal[1]; (*r).longVal[2] = (*a).longVal[2]; (*r).longVal[3] = (*a).longVal[3];
    } else {
        (*r).longVal[0] = (*a).longVal[0] >> shift;
        (*r).longVal[1] = ((*a).longVal[1] >> shift) | ((*a).longVal[0] << (64 - shift));
        (*r).longVal[2] = ((*a).longVal[2] >> shift) | ((*a).longVal[1] << (64 - shift));
        (*r).longVal[3] = ((*a).longVal[3] >> shift) | ((*a).longVal[2] << (64 - shift));
    }
}

// Bitwise shift left: r = a << b (use low limb of b as shift count)
void Fr_shl(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t shift = (*b).longVal[0] % 256;
    if (shift >= 64) {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else if (shift == 0) {
        (*r).longVal[0] = (*a).longVal[0]; (*r).longVal[1] = (*a).longVal[1]; (*r).longVal[2] = (*a).longVal[2]; (*r).longVal[3] = (*a).longVal[3];
    } else {
        (*r).longVal[3] = (*a).longVal[3] << shift;
        (*r).longVal[2] = ((*a).longVal[2] << shift) | ((*a).longVal[3] >> (64 - shift));
        (*r).longVal[1] = ((*a).longVal[1] << shift) | ((*a).longVal[2] >> (64 - shift));
        (*r).longVal[0] = ((*a).longVal[0] << shift) | ((*a).longVal[1] >> (64 - shift));
    }
}

// Bitwise AND: r = a & b
void Fr_band(PFrElement r, PFrElement a, PFrElement b) {
    for (int i = 0; i < 4; i++) (*r).longVal[i] = (*a).longVal[i] & (*b).longVal[i];
}

// Bitwise OR: r = a | b
void Fr_bor(PFrElement r, PFrElement a, PFrElement b) {
    for (int i = 0; i < 4; i++) (*r).longVal[i] = (*a).longVal[i] | (*b).longVal[i];
}

// Bitwise XOR: r = a ^ b
void Fr_bxor(PFrElement r, PFrElement a, PFrElement b) {
    for (int i = 0; i < 4; i++) (*r).longVal[i] = (*a).longVal[i] ^ (*b).longVal[i];
}

// Bitwise NOT: r = ~a
void Fr_not(PFrElement r, PFrElement a) {
    for (int i = 0; i < 4; i++) (*r).longVal[i] = ~(*a).longVal[i];
}

// Greater than: r = (a > b) ? 1 : 0
void Fr_gt(PFrElement r, PFrElement a, PFrElement b) {
    int c = Fr_cmp(a, b);
    if (c > 0) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Integer division: r = a / b (integer division of low limbs)
void Fr_idiv(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t divisor = (*b).longVal[0];
    if (divisor == 0) {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = (*a).longVal[0] / divisor;
        (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Logical AND: r = (a != 0 and b != 0) ? 1 : 0
void Fr_land(PFrElement r, PFrElement a, PFrElement b) {
    int a_nonzero = 0;
    int b_nonzero = 0;
    for (int i = 0; i < 4; i++) {
        if ((*a).longVal[i] != 0) a_nonzero = 1;
        if ((*b).longVal[i] != 0) b_nonzero = 1;
    }
    if (a_nonzero && b_nonzero) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Logical OR: r = (a != 0 or b != 0) ? 1 : 0
void Fr_lor(PFrElement r, PFrElement a, PFrElement b) {
    int a_nonzero = 0;
    int b_nonzero = 0;
    for (int i = 0; i < 4; i++) {
        if ((*a).longVal[i] != 0) a_nonzero = 1;
        if ((*b).longVal[i] != 0) b_nonzero = 1;
    }
    if (a_nonzero || b_nonzero) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Logical NOT: r = (a == 0) ? 1 : 0
void Fr_lnot(PFrElement r, PFrElement a) {
    int a_nonzero = 0;
    for (int i = 0; i < 4; i++) {
        if ((*a).longVal[i] != 0) a_nonzero = 1;
    }
    if (a_nonzero == 0) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Greater than or equal: r = (a >= b) ? 1 : 0
void Fr_geq(PFrElement r, PFrElement a, PFrElement b) {
    int c = Fr_cmp(a, b);
    if (c >= 0) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Less than or equal: r = (a <= b) ? 1 : 0
void Fr_leq(PFrElement r, PFrElement a, PFrElement b) {
    int c = Fr_cmp(a, b);
    if (c <= 0) {
        (*r).longVal[0] = 1; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    } else {
        (*r).longVal[0] = 0; (*r).longVal[1] = 0; (*r).longVal[2] = 0; (*r).longVal[3] = 0;
    }
}

// Modular division: r = (a / b) mod Q (alias for Fr_div)
void Fr_mod(PFrElement r, PFrElement a, PFrElement b) {
    Fr_div(r, a, b);
}
