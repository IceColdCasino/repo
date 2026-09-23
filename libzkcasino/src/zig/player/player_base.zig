const std = @import("std");
const zk = @import("../crypto/zk_crypto.zig");
const hash = @import("../crypto/hash.zig");
const poseidon = @import("../crypto/poseidon.zig");
const baby = @import("../crypto/babyjub.zig");

pub const Fr = @import("../crypto/fr.zig").Fr;
pub const Crypto = zk.Crypto;
pub const Ciphertext = zk.Ciphertext;
pub const PublicKey = zk.PublicKey;
pub const Point = zk.Point;
pub const PlayerKey = zk.PlayerKey;

pub const Player = struct {
    crypto: *Crypto,
    key: PlayerKey,

    pub fn init(crypto: *Crypto, key: PlayerKey) Player {
        return .{ .crypto = crypto, .key = key };
    }

    pub fn fromScalar(crypto: *Crypto, sk: Fr) Player {
        return .{ .crypto = crypto, .key = .{ .private_key = sk, .public_key = baby.mulBase8(sk) } };
    }

    pub fn padding(self: *const Player) Ciphertext {
        return self.crypto.getPadding(self.key.public_key);
    }

    pub fn registerOutputHash(self: *const Player) Fr {
        const pad = self.padding();
        return poseidon.hash(&.{ self.key.public_key.x, self.key.public_key.y, pad.c0x, pad.c0y, pad.c1x, pad.c1y });
    }

    pub fn shuffleHash(self: *const Player, deck: []const Ciphertext, keys: []const PublicKey) Fr {
        return self.crypto.shuffleHash(deck, keys);
    }

    pub fn shareHash(self: *const Player, cts: []const Ciphertext, others: []const PublicKey) Fr {
        return self.crypto.shareHash(cts, self.key.public_key, others);
    }
};

pub fn hashPublicKeys(keys: []const PublicKey) Fr {
    return hash.hashPublicKeysN(keys);
}

pub fn identityKey() PublicKey {
    return PublicKey.identity();
}

pub fn padKeys(keys: []const PublicKey, comptime n: usize, out: *[n]PublicKey) []PublicKey {
    std.debug.assert(keys.len <= n);
    @memcpy(out[0..keys.len], keys);
    var i = keys.len;
    while (i < n) : (i += 1) out[i] = PublicKey.identity();
    return out[0..n];
}
