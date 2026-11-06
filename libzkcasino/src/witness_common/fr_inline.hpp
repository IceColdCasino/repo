// Hot field ops, inlined into each generated witness.
// Values stay in Montgomery form. Add and sub are limb arithmetic.
// Multiply by 0 or 1 does not enter CIOS.

#ifndef FR_INLINE_HPP
#define FR_INLINE_HPP

static const uint32_t FR_MONT_BIT = 0x40000000u;
static const uint32_t FR_LONG_BIT = 0x80000000u;
static const uint64_t FR_Q0 = 0x43e1f593f0000001ull;
static const uint64_t FR_Q1 = 0x2833e84879b97091ull;
static const uint64_t FR_Q2 = 0xb85045b68181585dull;
static const uint64_t FR_Q3 = 0x30644e72e131a029ull;
static const uint64_t FR_R0 = 0xac96341c4ffffffbull;
static const uint64_t FR_R1 = 0x36fc76959f60cd29ull;
static const uint64_t FR_R2 = 0x666ea36f7879462eull;
static const uint64_t FR_R3 = 0x0e0a77c19a07df2full;
static const uint64_t FR_R2_0 = 0x1bb8e645ae216da7ull;
static const uint64_t FR_R2_1 = 0x53fe3ab1e35c59e3ull;
static const uint64_t FR_R2_2 = 0x8c49833d53bb8085ull;
static const uint64_t FR_R2_3 = 0x0216d0b17f4e44a5ull;
static const uint64_t FR_N0 = 0xc2e1f593efffffffull;

#define FR_AI __attribute__((always_inline)) static inline

FR_AI int fr_long(const FrElement* e) { return (e->type & FR_LONG_BIT) != 0; }
FR_AI int fr_mont(const FrElement* e) { return (e->type & FR_MONT_BIT) != 0; }

FR_AI int fr_cmp4(uint64_t a0, uint64_t a1, uint64_t a2, uint64_t a3,
                  uint64_t b0, uint64_t b1, uint64_t b2, uint64_t b3) {
    if (a3 != b3) return a3 < b3 ? -1 : 1;
    if (a2 != b2) return a2 < b2 ? -1 : 1;
    if (a1 != b1) return a1 < b1 ? -1 : 1;
    if (a0 != b0) return a0 < b0 ? -1 : 1;
    return 0;
}

FR_AI void fr_store_zero(FrElement* r) {
    r->shortVal = 0;
    r->type = FR_MONT_BIT;
    r->longVal[0] = 0;
    r->longVal[1] = 0;
    r->longVal[2] = 0;
    r->longVal[3] = 0;
}

FR_AI void fr_store_one(FrElement* r) {
    r->shortVal = 1;
    r->type = FR_MONT_BIT;
    r->longVal[0] = FR_R0;
    r->longVal[1] = FR_R1;
    r->longVal[2] = FR_R2;
    r->longVal[3] = FR_R3;
}

__attribute__((noinline)) static void fr_mont_mul(uint64_t* r, const uint64_t* a, const uint64_t* b) {
    uint64_t t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0;
    const uint64_t b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    const uint64_t bs[4] = {b0, b1, b2, b3};
    for (int i = 0; i < 4; i++) {
        const uint64_t bi = bs[i];
        unsigned __int128 carry = 0;
        unsigned __int128 prod;
        prod = (unsigned __int128)t0 + (unsigned __int128)a[0] * bi + carry;
        t0 = (uint64_t)prod;
        carry = prod >> 64;
        prod = (unsigned __int128)t1 + (unsigned __int128)a[1] * bi + carry;
        t1 = (uint64_t)prod;
        carry = prod >> 64;
        prod = (unsigned __int128)t2 + (unsigned __int128)a[2] * bi + carry;
        t2 = (uint64_t)prod;
        carry = prod >> 64;
        prod = (unsigned __int128)t3 + (unsigned __int128)a[3] * bi + carry;
        t3 = (uint64_t)prod;
        carry = prod >> 64;
        prod = (unsigned __int128)t4 + carry;
        t4 = (uint64_t)prod;
        t5 = (uint64_t)(prod >> 64);

        const uint64_t m = t0 * FR_N0;
        prod = (unsigned __int128)t0 + (unsigned __int128)m * FR_Q0;
        unsigned __int128 carry2 = prod >> 64;
        prod = (unsigned __int128)t1 + (unsigned __int128)m * FR_Q1 + carry2;
        t0 = (uint64_t)prod;
        carry2 = prod >> 64;
        prod = (unsigned __int128)t2 + (unsigned __int128)m * FR_Q2 + carry2;
        t1 = (uint64_t)prod;
        carry2 = prod >> 64;
        prod = (unsigned __int128)t3 + (unsigned __int128)m * FR_Q3 + carry2;
        t2 = (uint64_t)prod;
        carry2 = prod >> 64;
        prod = (unsigned __int128)t4 + carry2;
        t3 = (uint64_t)prod;
        prod = (prod >> 64) + t5;
        t4 = (uint64_t)prod;
        t5 = (uint64_t)(prod >> 64);
    }
    int reduce = t4 != 0 || t5 != 0 || fr_cmp4(t0, t1, t2, t3, FR_Q0, FR_Q1, FR_Q2, FR_Q3) >= 0;
    if (reduce) {
        unsigned __int128 borrow = 0;
        unsigned __int128 diff;
        diff = (unsigned __int128)t0 - FR_Q0 - borrow;
        t0 = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)t1 - FR_Q1 - borrow;
        t1 = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)t2 - FR_Q2 - borrow;
        t2 = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)t3 - FR_Q3 - borrow;
        t3 = (uint64_t)diff;
        if (fr_cmp4(t0, t1, t2, t3, FR_Q0, FR_Q1, FR_Q2, FR_Q3) >= 0) {
            borrow = 0;
            diff = (unsigned __int128)t0 - FR_Q0 - borrow;
            t0 = (uint64_t)diff;
            borrow = (diff >> 64) & 1;
            diff = (unsigned __int128)t1 - FR_Q1 - borrow;
            t1 = (uint64_t)diff;
            borrow = (diff >> 64) & 1;
            diff = (unsigned __int128)t2 - FR_Q2 - borrow;
            t2 = (uint64_t)diff;
            borrow = (diff >> 64) & 1;
            diff = (unsigned __int128)t3 - FR_Q3 - borrow;
            t3 = (uint64_t)diff;
        }
    }
    r[0] = t0;
    r[1] = t1;
    r[2] = t2;
    r[3] = t3;
}

FR_AI void fr_to_mont(uint64_t* r, const uint64_t* a) {
    const uint64_t r2[4] = {FR_R2_0, FR_R2_1, FR_R2_2, FR_R2_3};
    fr_mont_mul(r, a, r2);
}

FR_AI void fr_from_mont(uint64_t* r, const uint64_t* a) {
    const uint64_t one[4] = {1, 0, 0, 0};
    fr_mont_mul(r, a, one);
}

FR_AI void fr_short_normal(int32_t sv, uint64_t* o) {
    if (sv >= 0) {
        o[0] = (uint64_t)sv;
        o[1] = 0;
        o[2] = 0;
        o[3] = 0;
        return;
    }
    uint64_t borrow = (uint64_t)(-(int64_t)sv);
    unsigned __int128 diff;
    diff = (unsigned __int128)FR_Q0 - borrow;
    o[0] = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q1 - borrow;
    o[1] = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q2 - borrow;
    o[2] = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q3 - borrow;
    o[3] = (uint64_t)diff;
}

FR_AI void fr_load_normal(uint64_t* o, const FrElement* e) {
    if (!fr_long(e)) {
        fr_short_normal(e->shortVal, o);
        return;
    }
    if (fr_mont(e)) {
        fr_from_mont(o, e->longVal);
        return;
    }
    o[0] = e->longVal[0];
    o[1] = e->longVal[1];
    o[2] = e->longVal[2];
    o[3] = e->longVal[3];
}

FR_AI void fr_store_mont(FrElement* r, const uint64_t* m, int have_short, int32_t s) {
    if (have_short) {
        if (s == 0) {
            fr_store_zero(r);
            return;
        }
        if (s == 1) {
            fr_store_one(r);
            return;
        }
        r->shortVal = s;
        r->type = FR_MONT_BIT;
    } else {
        r->shortVal = 0;
        r->type = FR_MONT_BIT | FR_LONG_BIT;
    }
    r->longVal[0] = m[0];
    r->longVal[1] = m[1];
    r->longVal[2] = m[2];
    r->longVal[3] = m[3];
}

FR_AI int fr_as_i32(const uint64_t* n, int32_t* out) {
    if (n[1] == 0 && n[2] == 0 && n[3] == 0 && n[0] <= 0x7fffffffu) {
        *out = (int32_t)n[0];
        return 1;
    }
    uint64_t mag0, mag1, mag2, mag3;
    unsigned __int128 borrow = 0;
    unsigned __int128 diff;
    diff = (unsigned __int128)FR_Q0 - n[0] - borrow;
    mag0 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q1 - n[1] - borrow;
    mag1 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q2 - n[2] - borrow;
    mag2 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q3 - n[3] - borrow;
    mag3 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    if (borrow == 0 && mag1 == 0 && mag2 == 0 && mag3 == 0 && mag0 > 0 && mag0 <= 0x80000000u) {
        if (mag0 == 0x80000000u) *out = (int32_t)0x80000000u;
        else *out = -(int32_t)mag0;
        return 1;
    }
    return 0;
}

FR_AI void fr_store_normal(FrElement* r, const uint64_t* n) {
    int32_t s = 0;
    if (fr_as_i32(n, &s)) {
        if (s == 0) {
            fr_store_zero(r);
            return;
        }
        if (s == 1) {
            fr_store_one(r);
            return;
        }
        uint64_t m[4];
        fr_to_mont(m, n);
        fr_store_mont(r, m, 1, s);
        return;
    }
    r->shortVal = 0;
    r->type = FR_LONG_BIT;
    r->longVal[0] = n[0];
    r->longVal[1] = n[1];
    r->longVal[2] = n[2];
    r->longVal[3] = n[3];
}

FR_AI void fr_add_mod(uint64_t* o, const uint64_t* a, const uint64_t* b) {
    unsigned __int128 carry = 0;
    unsigned __int128 sum;
    uint64_t r0, r1, r2, r3;
    sum = (unsigned __int128)a[0] + b[0] + carry;
    r0 = (uint64_t)sum;
    carry = sum >> 64;
    sum = (unsigned __int128)a[1] + b[1] + carry;
    r1 = (uint64_t)sum;
    carry = sum >> 64;
    sum = (unsigned __int128)a[2] + b[2] + carry;
    r2 = (uint64_t)sum;
    carry = sum >> 64;
    sum = (unsigned __int128)a[3] + b[3] + carry;
    r3 = (uint64_t)sum;
    carry = sum >> 64;
    if (carry != 0 || fr_cmp4(r0, r1, r2, r3, FR_Q0, FR_Q1, FR_Q2, FR_Q3) >= 0) {
        unsigned __int128 borrow = 0;
        unsigned __int128 diff;
        diff = (unsigned __int128)r0 - FR_Q0 - borrow;
        r0 = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)r1 - FR_Q1 - borrow;
        r1 = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)r2 - FR_Q2 - borrow;
        r2 = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)r3 - FR_Q3 - borrow;
        r3 = (uint64_t)diff;
    }
    o[0] = r0;
    o[1] = r1;
    o[2] = r2;
    o[3] = r3;
}

FR_AI void fr_sub_mod(uint64_t* o, const uint64_t* a, const uint64_t* b) {
    if (fr_cmp4(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]) >= 0) {
        unsigned __int128 borrow = 0;
        unsigned __int128 diff;
        diff = (unsigned __int128)a[0] - b[0] - borrow;
        o[0] = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)a[1] - b[1] - borrow;
        o[1] = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)a[2] - b[2] - borrow;
        o[2] = (uint64_t)diff;
        borrow = (diff >> 64) & 1;
        diff = (unsigned __int128)a[3] - b[3] - borrow;
        o[3] = (uint64_t)diff;
        return;
    }
    uint64_t gap0, gap1, gap2, gap3;
    unsigned __int128 borrow = 0;
    unsigned __int128 diff;
    diff = (unsigned __int128)b[0] - a[0] - borrow;
    gap0 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)b[1] - a[1] - borrow;
    gap1 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)b[2] - a[2] - borrow;
    gap2 = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)b[3] - a[3] - borrow;
    gap3 = (uint64_t)diff;
    borrow = 0;
    diff = (unsigned __int128)FR_Q0 - gap0 - borrow;
    o[0] = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q1 - gap1 - borrow;
    o[1] = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q2 - gap2 - borrow;
    o[2] = (uint64_t)diff;
    borrow = (diff >> 64) & 1;
    diff = (unsigned __int128)FR_Q3 - gap3 - borrow;
    o[3] = (uint64_t)diff;
}

FR_AI void fr_load_mont_fix(uint64_t* o, const FrElement* e) {
    if (fr_mont(e)) {
        o[0] = e->longVal[0];
        o[1] = e->longVal[1];
        o[2] = e->longVal[2];
        o[3] = e->longVal[3];
        return;
    }
    uint64_t n[4];
    fr_load_normal(n, e);
    fr_to_mont(o, n);
}

FR_AI void Fr_copy(PFrElement r, PFrElement a) { *r = *a; }

FR_AI void Fr_copyn(PFrElement r, PFrElement a, size_t n) {
    for (size_t i = 0; i < n; i++) r[i] = a[i];
}

FR_AI void Fr_add(PFrElement r, PFrElement a, PFrElement b) {
    const int a_long = fr_long(a);
    const int b_long = fr_long(b);
    const int a_mont = fr_mont(a);
    const int b_mont = fr_mont(b);
    int have = 0;
    int32_t s = 0;
    if (!a_long && !b_long) {
        const int64_t sum = (int64_t)a->shortVal + (int64_t)b->shortVal;
        if (sum >= (-2147483647 - 1) && sum <= 2147483647) {
            have = 1;
            s = (int32_t)sum;
        }
    }
    if (a_mont && b_mont) {
        uint64_t m[4];
        fr_add_mod(m, a->longVal, b->longVal);
        fr_store_mont(r, m, have, s);
        return;
    }
    if (have && !a_mont && !b_mont) {
        r->shortVal = s;
        r->type = 0;
        r->longVal[0] = r->longVal[1] = r->longVal[2] = r->longVal[3] = 0;
        return;
    }
    uint64_t am[4], bm[4], m[4];
    fr_load_mont_fix(am, a);
    fr_load_mont_fix(bm, b);
    fr_add_mod(m, am, bm);
    fr_store_mont(r, m, have, s);
}

FR_AI void Fr_sub(PFrElement r, PFrElement a, PFrElement b) {
    const int a_long = fr_long(a);
    const int b_long = fr_long(b);
    const int a_mont = fr_mont(a);
    const int b_mont = fr_mont(b);
    int have = 0;
    int32_t s = 0;
    if (!a_long && !b_long) {
        const int64_t diff = (int64_t)a->shortVal - (int64_t)b->shortVal;
        if (diff >= (-2147483647 - 1) && diff <= 2147483647) {
            have = 1;
            s = (int32_t)diff;
        }
    }
    if (a_mont && b_mont) {
        uint64_t m[4];
        fr_sub_mod(m, a->longVal, b->longVal);
        fr_store_mont(r, m, have, s);
        return;
    }
    if (have && !a_mont && !b_mont) {
        r->shortVal = s;
        r->type = 0;
        r->longVal[0] = r->longVal[1] = r->longVal[2] = r->longVal[3] = 0;
        return;
    }
    uint64_t am[4], bm[4], m[4];
    fr_load_mont_fix(am, a);
    fr_load_mont_fix(bm, b);
    fr_sub_mod(m, am, bm);
    fr_store_mont(r, m, have, s);
}

FR_AI void Fr_neg(PFrElement r, PFrElement a) {
    if (!fr_long(a) && a->shortVal == 0) {
        fr_store_zero(r);
        return;
    }
    if (!fr_long(a) && a->shortVal != (int32_t)0x80000000u) {
        const int32_t s = (int32_t)(-a->shortVal);
        if (!fr_mont(a)) {
            r->shortVal = s;
            r->type = 0;
            r->longVal[0] = r->longVal[1] = r->longVal[2] = r->longVal[3] = 0;
            return;
        }
        uint64_t m[4];
        if ((a->longVal[0] | a->longVal[1] | a->longVal[2] | a->longVal[3]) == 0) {
            fr_store_mont(r, a->longVal, 1, s);
            return;
        }
        const uint64_t z[4] = {0, 0, 0, 0};
        fr_sub_mod(m, z, a->longVal);
        // sub_mod(0, x) = Q - x for x != 0. x == 0 handled above.
        fr_store_mont(r, m, 1, s);
        return;
    }
    uint64_t am[4], m[4];
    fr_load_mont_fix(am, a);
    if ((am[0] | am[1] | am[2] | am[3]) == 0) {
        fr_store_zero(r);
        return;
    }
    const uint64_t z[4] = {0, 0, 0, 0};
    fr_sub_mod(m, z, am);
    fr_store_mont(r, m, 0, 0);
}

FR_AI void Fr_mul(PFrElement r, PFrElement a, PFrElement b) {
    if (!fr_long(a) && a->shortVal == 0) {
        fr_store_zero(r);
        return;
    }
    if (!fr_long(b) && b->shortVal == 0) {
        fr_store_zero(r);
        return;
    }
    if (!fr_long(b) && b->shortVal == 1 && fr_mont(b)) {
        *r = *a;
        return;
    }
    if (!fr_long(a) && a->shortVal == 1 && fr_mont(a)) {
        *r = *b;
        return;
    }
    int have = 0;
    int32_t s = 0;
    if (!fr_long(a) && !fr_long(b)) {
        const int64_t prod = (int64_t)a->shortVal * (int64_t)b->shortVal;
        if (prod >= (-2147483647 - 1) && prod <= 2147483647) {
            have = 1;
            s = (int32_t)prod;
        }
    }
    uint64_t am[4], bm[4], m[4];
    fr_load_mont_fix(am, a);
    fr_load_mont_fix(bm, b);
    fr_mont_mul(m, am, bm);
    fr_store_mont(r, m, have, s);
}

FR_AI void Fr_sqr(PFrElement r, PFrElement a) { Fr_mul(r, a, a); }
FR_AI void Fr_square(PFrElement r, PFrElement a) { Fr_mul(r, a, a); }

FR_AI int Fr_isTrue(PFrElement a) {
    if (!fr_long(a)) return a->shortVal != 0;
    return (a->longVal[0] | a->longVal[1] | a->longVal[2] | a->longVal[3]) != 0;
}

FR_AI int Fr_isZero(PFrElement a) { return !Fr_isTrue(a); }

FR_AI uint64_t Fr_toInt(PFrElement a) {
    if (!fr_long(a)) return (uint64_t)(int64_t)a->shortVal;
    uint64_t n[4];
    fr_load_normal(n, a);
    int32_t s = 0;
    if (fr_as_i32(n, &s)) return (uint64_t)(int64_t)s;
    return n[0];
}

FR_AI int fr_same(const FrElement* a, const FrElement* b) {
    if (!fr_long(a) && !fr_long(b)) return a->shortVal == b->shortVal;
    if (fr_mont(a) && fr_mont(b)) {
        return a->longVal[0] == b->longVal[0] && a->longVal[1] == b->longVal[1] &&
               a->longVal[2] == b->longVal[2] && a->longVal[3] == b->longVal[3];
    }
    uint64_t an[4], bn[4];
    fr_load_normal(an, a);
    fr_load_normal(bn, b);
    return fr_cmp4(an[0], an[1], an[2], an[3], bn[0], bn[1], bn[2], bn[3]) == 0;
}

FR_AI int fr_cmp_elem(const FrElement* a, const FrElement* b) {
    if (!fr_long(a) && !fr_long(b)) {
        if (a->shortVal < b->shortVal) return -1;
        if (a->shortVal > b->shortVal) return 1;
        return 0;
    }
    uint64_t an[4], bn[4];
    fr_load_normal(an, a);
    fr_load_normal(bn, b);
    return fr_cmp4(an[0], an[1], an[2], an[3], bn[0], bn[1], bn[2], bn[3]);
}

FR_AI void fr_bool(PFrElement r, int v) {
    if (v) fr_store_one(r);
    else fr_store_zero(r);
}

FR_AI void Fr_eq(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, fr_same(a, b)); }
FR_AI void Fr_neq(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, !fr_same(a, b)); }
FR_AI void Fr_lt(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, fr_cmp_elem(a, b) < 0); }
FR_AI void Fr_gt(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, fr_cmp_elem(a, b) > 0); }
FR_AI void Fr_leq(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, fr_cmp_elem(a, b) <= 0); }
FR_AI void Fr_geq(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, fr_cmp_elem(a, b) >= 0); }
FR_AI int Fr_cmp(PFrElement a, PFrElement b) { return fr_cmp_elem(a, b); }

FR_AI void Fr_land(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, Fr_isTrue(a) && Fr_isTrue(b)); }
FR_AI void Fr_lor(PFrElement r, PFrElement a, PFrElement b) { fr_bool(r, Fr_isTrue(a) || Fr_isTrue(b)); }
FR_AI void Fr_lnot(PFrElement r, PFrElement a) { fr_bool(r, !Fr_isTrue(a)); }

FR_AI uint32_t fr_shift_count(const FrElement* e) {
    if (!fr_long(e)) {
        if (e->shortVal < 0 || e->shortVal >= 256) return 256;
        return (uint32_t)e->shortVal;
    }
    uint64_t n[4];
    fr_load_normal(n, e);
    if (n[1] | n[2] | n[3] | (n[0] >= 256)) return 256;
    return (uint32_t)n[0];
}

FR_AI void fr_shr_limbs(uint64_t* o, const uint64_t* a, uint32_t n) {
    o[0] = o[1] = o[2] = o[3] = 0;
    if (n >= 256) return;
    const uint32_t limb = n / 64;
    const uint32_t bits = n % 64;
    for (uint32_t i = 0; i + limb < 4; i++) {
        uint64_t v = a[i + limb] >> bits;
        if (bits && i + limb + 1 < 4) v |= a[i + limb + 1] << (64 - bits);
        o[i] = v;
    }
}

FR_AI void fr_shl_limbs(uint64_t* o, const uint64_t* a, uint32_t n) {
    o[0] = o[1] = o[2] = o[3] = 0;
    if (n >= 256) return;
    const uint32_t limb = n / 64;
    const uint32_t bits = n % 64;
    for (uint32_t i = limb; i < 4; i++) {
        uint64_t v = a[i - limb] << bits;
        if (bits && i >= limb + 1) v |= a[i - limb - 1] >> (64 - bits);
        o[i] = v;
    }
}

FR_AI void Fr_shr(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t n[4], o[4];
    fr_load_normal(n, a);
    fr_shr_limbs(o, n, fr_shift_count(b));
    fr_store_normal(r, o);
}

FR_AI void Fr_shl(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t n[4], o[4];
    fr_load_normal(n, a);
    fr_shl_limbs(o, n, fr_shift_count(b));
    fr_store_normal(r, o);
}

FR_AI void fr_bit(PFrElement r, const uint64_t* a, const uint64_t* b, int op) {
    uint64_t o[4];
    for (int i = 0; i < 4; i++) {
        if (op == 0) o[i] = a[i] & b[i];
        else if (op == 1) o[i] = a[i] | b[i];
        else o[i] = a[i] ^ b[i];
    }
    fr_store_normal(r, o);
}

FR_AI void Fr_band(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t an[4], bn[4];
    fr_load_normal(an, a);
    fr_load_normal(bn, b);
    fr_bit(r, an, bn, 0);
}

FR_AI void Fr_bor(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t an[4], bn[4];
    fr_load_normal(an, a);
    fr_load_normal(bn, b);
    fr_bit(r, an, bn, 1);
}

FR_AI void Fr_bxor(PFrElement r, PFrElement a, PFrElement b) {
    uint64_t an[4], bn[4];
    fr_load_normal(an, a);
    fr_load_normal(bn, b);
    fr_bit(r, an, bn, 2);
}

FR_AI void Fr_bnot(PFrElement r, PFrElement a) {
    uint64_t n[4], o[4];
    fr_load_normal(n, a);
    o[0] = ~n[0];
    o[1] = ~n[1];
    o[2] = ~n[2];
    o[3] = ~n[3];
    fr_store_normal(r, o);
}

FR_AI void Fr_not(PFrElement r, PFrElement a) { Fr_bnot(r, a); }

#undef FR_AI

#endif
