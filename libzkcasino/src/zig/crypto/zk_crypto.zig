const std = @import("std");
const Fr = @import("fr.zig").Fr;
const poseidon = @import("poseidon.zig");
const baby = @import("babyjub.zig");
const elg = @import("elgamal.zig");
const hash = @import("hash.zig");

pub const Point = baby.Point;
pub const Ciphertext = elg.Ciphertext;
pub const PublicKey = elg.PublicKey;
pub const Delta = elg.Delta;

pub const PlayerKey = struct {
    private_key: Fr,
    public_key: PublicKey,
};

pub const Rng = struct {
    prng: std.Random.DefaultPrng,

    pub fn init(seed: u64) Rng {
        return .{ .prng = .init(if (seed == 0) osSeed() else seed) };
    }

    pub fn random(self: *Rng) std.Random {
        return self.prng.random();
    }

    pub fn next(self: *Rng) u64 {
        return self.random().int(u64);
    }

    /// Field element in `[0, q)` via Zig `std.Random` + libfr `mod q` (not a 253-bit mask).
    pub fn field(self: *Rng) Fr {
        return Fr.random(self.random());
    }

    pub fn nonzero(self: *Rng) Fr {
        while (true) {
            const r = self.field();
            if (!r.isZero()) return r;
        }
    }

    /// Non-zero Fr in `[1, 2^253)` — ElGamal circuits use `Num2Bits(253)`.
    pub fn scalar253(self: *Rng) Fr {
        while (true) {
            var limbs: [4]u64 = undefined;
            self.random().bytes(std.mem.asBytes(&limbs));
            limbs[3] &= (1 << 61) - 1;
            const r = Fr.fromNormal(limbs);
            if (!r.isZero()) return r;
        }
    }

    pub fn index(self: *Rng, less_than: usize) usize {
        return self.random().uintLessThan(usize, less_than);
    }
};

fn osSeed() u64 {
    var bytes: [8]u8 = undefined;
    if (comptime @TypeOf(std.c.arc4random_buf) != void) {
        std.c.arc4random_buf(&bytes, bytes.len);
    } else if (comptime @TypeOf(std.c.getrandom) != void) {
        const n = std.c.getrandom(&bytes, bytes.len, 0);
        if (n != bytes.len) @panic("getrandom failed");
    } else {
        @compileError("no OS CSPRNG for Rng.init(0)");
    }
    return std.mem.readInt(u64, &bytes, .little);
}

pub const Crypto = struct {
    rng: Rng,
    catalog: []Ciphertext,
    storage: []Ciphertext,

    pub fn init(allocator: std.mem.Allocator, shoe_size: usize, seed: u64) !Crypto {
        const storage = try allocator.alloc(Ciphertext, shoe_size);
        fillIdentity(storage);
        return .{
            .rng = Rng.init(seed),
            .catalog = storage,
            .storage = storage,
        };
    }

    pub fn deinit(self: *Crypto, allocator: std.mem.Allocator) void {
        allocator.free(self.storage);
    }

    pub fn poseidonHash(self: *const Crypto, inputs: []const Fr) Fr {
        _ = self;
        return poseidon.hash(inputs);
    }

    pub fn generatePlayerKey(self: *Crypto) PlayerKey {
        const min = Fr.fromU64(1024);
        const max = baby.subOrder().sub(Fr.one());
        while (true) {
            const sk = self.rng.field();
            if (sk.cmpNormal(min) > 0 and sk.cmpNormal(max) <= 0 and !sk.isZero()) {
                return .{ .private_key = sk, .public_key = baby.mulBase8(sk) };
            }
        }
    }

    pub fn createPartialDecryption(_: *const Crypto, sk: Fr, ct: Ciphertext) Delta {
        return elg.createPartial(sk, ct);
    }

    pub fn reencryptPartialForRecipient(
        _: *const Crypto,
        partial: Delta,
        recipient: PublicKey,
        randomness: Fr,
        use_identity: bool,
    ) Ciphertext {
        return elg.reencryptPartial(partial, recipient, randomness, use_identity);
    }

    pub fn hashPermutationMatrix(_: *const Crypto, matrix: []const u8, matrix_size: usize) Fr {
        return hash.hashPermutationMatrix(matrix, matrix_size);
    }

    pub fn getPadding(_: *const Crypto, pk: PublicKey) Ciphertext {
        return elg.getPadding(pk);
    }

    pub fn aggregatePublicKeys(_: *const Crypto, keys: []const PublicKey) PublicKey {
        return baby.aggregate(keys);
    }

    pub fn getRandom(self: *Crypto) Fr {
        return self.rng.field();
    }

    pub fn hashCiphertexts(_: *const Crypto, cts: []const Ciphertext) Fr {
        return hash.hashCiphertexts(cts);
    }

    pub fn deckHash(self: *const Crypto, deck: []const Ciphertext) Fr {
        return self.hashCiphertexts(deck);
    }

    pub fn shareHash(self: *const Crypto, cts: []const Ciphertext, pk: PublicKey, others: []const PublicKey) Fr {
        var keys: [12]PublicKey = undefined;
        keys[0] = pk;
        @memcpy(keys[1 .. 1 + others.len], others);
        const n = 1 + others.len;
        const pk_hash = hash.hashPublicKeysN(keys[0..n]);
        return poseidon.hash(&.{ self.hashCiphertexts(cts), pk_hash });
    }

    pub fn shuffleHash(_: *const Crypto, deck: []const Ciphertext, keys: []const PublicKey) Fr {
        var padded: [12]PublicKey = undefined;
        const pk = hash.padShuffleKeys(keys, &padded);
        return poseidon.hash(&.{ hash.hashCiphertexts(deck), hash.hashPublicKeys12(pk) });
    }

    pub const MAX_PERM: usize = 312;

    pub fn generateShufflePermutation(self: *Crypto, n: usize, out: []u8) void {
        std.debug.assert(out.len == n * n);
        var perm: [MAX_PERM]u16 = undefined;
        self.derangement(perm[0..n]);
        @memset(out, 0);
        var i: usize = 0;
        while (i < n) : (i += 1) {
            out[i * n + perm[i]] = 1;
        }
    }

    pub fn generateShuffleRandomness(self: *Crypto, n: usize, out: []Fr) void {
        var i: usize = 0;
        while (i < n) : (i += 1) out[i] = self.rng.scalar253();
    }

    pub fn shuffle(
        _: *const Crypto,
        deck: []const Ciphertext,
        keys: []const PublicKey,
        matrix: []const u8,
        randomness: []const Fr,
        out: []Ciphertext,
        matrix_size: usize,
    ) Fr {
        const n = deck.len;
        const pk_agg = baby.aggregate(keys);
        var i: usize = 0;
        while (i < n) : (i += 1) {
            var src: usize = 0;
            var j: usize = 0;
            while (j < n) : (j += 1) {
                if (matrix[i * n + j] == 1) {
                    src = j;
                    break;
                }
            }
            const card = deck[src];
            const r = randomness[i];
            const new_c0 = baby.add(card.c0(), baby.mulBase8(r));
            const new_c1 = baby.add(card.c1(), baby.mul(pk_agg, r));
            out[i] = Ciphertext.fromPoints(new_c0, new_c1);
        }
        return hash.hashPermutationMatrix(matrix, matrix_size);
    }

    pub fn share(
        self: *const Crypto,
        cts: []const Ciphertext,
        recipients: []const PublicKey,
        sk: Fr,
        randomness: []const []const Fr,
        out: [][]Ciphertext,
    ) void {
        _ = self;
        var p: usize = 0;
        while (p < recipients.len) : (p += 1) {
            var c: usize = 0;
            while (c < cts.len) : (c += 1) {
                const partial = elg.createPartial(sk, cts[c]);
                out[p][c] = elg.reencryptPartial(partial, recipients[p], randomness[p][c], false);
            }
        }
    }

    pub fn encrypt(self: *const Crypto, pt: Point, pk: PublicKey, r: Fr) Ciphertext {
        _ = self;
        return elg.encrypt(pt, pk, r);
    }

    pub fn encryptScalar(self: *const Crypto, value: u64, pk: PublicKey, r: Fr) Ciphertext {
        _ = self;
        return elg.encryptScalar(value + 1, pk, r);
    }

    /// Recover a card encrypted solely under `sk`'s public key: `m = c1 - sk·c0`, then catalog search.
    pub fn decryptWithSk(self: *const Crypto, sk: Fr, ct: Ciphertext) isize {
        return self.decryptCard(ct, elg.createPartial(sk, ct));
    }

    /// Recover `m = c1 - aggregated` and find it in the pre-generated identity catalog.
    pub fn decryptCard(self: *const Crypto, ct: Ciphertext, aggregated: Delta) isize {
        return self.catalogIndex(elg.decryptCardPoint(ct, aggregated));
    }

    /// Linear scan of `Base8*(i+1)` identity encodings (same list TypeScript `plaintextCatalog` uses).
    pub fn catalogIndex(self: *const Crypto, m: Point) isize {
        for (self.catalog, 0..) |card, i| {
            if (card.c1x.eql(m.x) and card.c1y.eql(m.y)) return @intCast(i);
        }
        return -1;
    }

    pub fn decryptFromPartials(
        self: *const Crypto,
        sk: Fr,
        ct: Ciphertext,
        received: []const Ciphertext,
    ) isize {
        var sum = Point.identity();
        for (received) |enc| {
            sum = baby.add(sum, elg.decryptReencrypted(enc, sk));
        }
        sum = baby.add(sum, elg.createPartial(sk, ct));
        return self.decryptCard(ct, sum);
    }

    pub fn decryptCards(
        self: *const Crypto,
        sk: Fr,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
        out: []u64,
    ) !void {
        var i: usize = 0;
        while (i < cards.len) : (i += 1) {
            var received_buf: [16]Ciphertext = undefined;
            var r: usize = 0;
            while (r < partials.len) : (r += 1) {
                received_buf[r] = partials[r][i];
            }
            const idx = self.decryptFromPartials(sk, cards[i], received_buf[0..partials.len]);
            if (idx < 0) return error.DecryptFailed;
            out[i] = @intCast(idx);
        }
    }

    /// Fisher–Yates + rejection: permutation of `0..n-1` with no fixed points.
    pub fn derangement(self: *Crypto, out: []u16) void {
        const n = out.len;
        std.debug.assert(n > 0 and n <= MAX_PERM);
        var attempt: usize = 0;
        while (attempt < 1000) : (attempt += 1) {
            var i: usize = 0;
            while (i < n) : (i += 1) out[i] = @intCast(i);
            i = n;
            while (i > 1) {
                i -= 1;
                const j = self.rng.index(i + 1);
                const tmp = out[i];
                out[i] = out[j];
                out[j] = tmp;
            }
            var ok = true;
            i = 0;
            while (i < n) : (i += 1) {
                if (out[i] == i) {
                    ok = false;
                    break;
                }
            }
            if (ok) return;
        }
        @panic("derangement failed");
    }
};

pub fn fillIdentity(dest: []Ciphertext) void {
    for (dest, 0..) |*slot, i| {
        const pt = baby.mulBase8Limbs(.{ @as(u64, @intCast(i + 1)), 0, 0, 0 });
        slot.* = Ciphertext.fromPoints(Point.identity(), pt);
    }
}

pub fn fillRepeatedRank(dest: []Ciphertext, decks: usize, ranks: usize) void {
    var i: usize = 0;
    var d: usize = 0;
    while (d < decks) : (d += 1) {
        var r: usize = 0;
        while (r < ranks) : (r += 1) {
            const pt = baby.mulBase8Limbs(.{ @as(u64, @intCast(r + 1)), 0, 0, 0 });
            dest[i] = Ciphertext.fromPoints(Point.identity(), pt);
            i += 1;
        }
    }
}

pub fn flattenShare(cts: []const []const Ciphertext, out: []Fr) void {
    var n: usize = 0;
    for (cts) |row| {
        for (row) |ct| {
            const lim = ct.limbs();
            inline for (0..4) |k| {
                out[n] = lim[k];
                n += 1;
            }
        }
    }
}
