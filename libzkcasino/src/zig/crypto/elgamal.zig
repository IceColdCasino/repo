const Fr = @import("fr.zig").Fr;
const baby = @import("babyjub.zig");

pub const Point = baby.Point;
pub const PublicKey = Point;
pub const Delta = Point;

pub const Ciphertext = struct {
    c0x: Fr,
    c0y: Fr,
    c1x: Fr,
    c1y: Fr,

    pub fn c0(self: Ciphertext) Point {
        return .{ .x = self.c0x, .y = self.c0y };
    }
    pub fn c1(self: Ciphertext) Point {
        return .{ .x = self.c1x, .y = self.c1y };
    }
    pub fn fromPoints(p0: Point, p1: Point) Ciphertext {
        return .{ .c0x = p0.x, .c0y = p0.y, .c1x = p1.x, .c1y = p1.y };
    }
    pub fn limbs(self: Ciphertext) [4]Fr {
        return .{ self.c0x, self.c0y, self.c1x, self.c1y };
    }
};

pub fn encrypt(plaintext: Point, pk: PublicKey, randomness: Fr) Ciphertext {
    const c0 = baby.mulBase8(randomness);
    const c1 = baby.add(plaintext, baby.mul(pk, randomness));
    return Ciphertext.fromPoints(c0, c1);
}

pub fn encryptScalar(value_plus_one: u64, pk: PublicKey, randomness: Fr) Ciphertext {
    return encrypt(baby.mulBase8Limbs(.{ value_plus_one, 0, 0, 0 }), pk, randomness);
}

pub fn createPartial(sk: Fr, ct: Ciphertext) Delta {
    return baby.mul(ct.c0(), sk);
}

pub fn reencryptPartial(partial: Delta, recipient: PublicKey, randomness: Fr, use_identity: bool) Ciphertext {
    const c0 = baby.mulBase8(randomness);
    const d = if (use_identity) Point.identity() else partial;
    const c1 = baby.add(d, baby.mul(recipient, randomness));
    return Ciphertext.fromPoints(c0, c1);
}

pub fn decryptReencrypted(ct: Ciphertext, sk: Fr) Delta {
    const sk_c0 = baby.mul(ct.c0(), sk);
    const neg = Point{ .x = sk_c0.x.neg(), .y = sk_c0.y };
    return baby.add(ct.c1(), neg);
}

pub fn decryptCardPoint(ct: Ciphertext, aggregated: Delta) Point {
    const neg = Point{ .x = aggregated.x.neg(), .y = aggregated.y };
    return baby.add(ct.c1(), neg);
}

pub fn getPadding(recipient: PublicKey) Ciphertext {
    return reencryptPartial(Point.identity(), recipient, Fr.one(), false);
}
