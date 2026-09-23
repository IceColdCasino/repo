//! Stateful table player: keying + Groth16 via libzkcasino witness + rapidsnark.
const std = @import("std");
const zk = @import("../crypto/zk_crypto.zig");
const hash = @import("../crypto/hash.zig");
const baby = @import("../crypto/babyjub.zig");
const prove = @import("../prove.zig");
const base = @import("player_base.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;
pub const PlayerKey = base.PlayerKey;
pub const Engine = prove.Engine;
pub const CircuitId = prove.CircuitId;
pub const Proof = prove.Proof;

pub const RegisterOut = struct {
    proof: Proof,
    public_key: PublicKey,
    padding: Ciphertext,

    pub fn deinit(self: *RegisterOut) void {
        self.proof.deinit();
    }
};

pub const ShuffleOut = struct {
    proof: Proof,
    deck: []Ciphertext,
    permutation_hash: Fr,
    alloc: std.mem.Allocator,

    pub fn deinit(self: *ShuffleOut) void {
        self.proof.deinit();
        self.alloc.free(self.deck);
    }
};

pub const ShareOut = struct {
    proof: Proof,
    rows: [][]Ciphertext,
    flat: []Ciphertext,
    alloc: std.mem.Allocator,

    pub fn deinit(self: *ShareOut) void {
        self.proof.deinit();
        self.alloc.free(self.rows);
        self.alloc.free(self.flat);
    }
};

pub const TablePlayer = struct {
    alloc: std.mem.Allocator,
    crypto: *Crypto,
    key: ?PlayerKey = null,
    engine: *Engine,
    owns_crypto: bool = false,
    sealed: []const Fr = &.{},

    pub fn init(alloc: std.mem.Allocator, engine: *Engine, crypto: *Crypto) TablePlayer {
        return .{ .alloc = alloc, .engine = engine, .crypto = crypto };
    }

    pub fn initOwned(alloc: std.mem.Allocator, engine: *Engine, shoe: usize, seed: u64) !TablePlayer {
        const crypto = try alloc.create(Crypto);
        errdefer alloc.destroy(crypto);
        crypto.* = try Crypto.init(alloc, shoe, seed);
        return .{ .alloc = alloc, .engine = engine, .crypto = crypto, .owns_crypto = true };
    }

    pub fn deinit(self: *TablePlayer) void {
        if (self.owns_crypto) {
            self.crypto.deinit(self.alloc);
            self.alloc.destroy(self.crypto);
        }
    }

    pub fn generateKey(self: *TablePlayer) void {
        if (self.key == null) self.key = self.crypto.generatePlayerKey();
    }

    pub fn loadKey(self: *TablePlayer, key: PlayerKey) void {
        self.key = key;
    }

    pub fn publicKey(self: *const TablePlayer) PublicKey {
        return (self.key orelse @panic("key not generated")).public_key;
    }

    pub fn privateKey(self: *const TablePlayer) Fr {
        const k = self.key orelse @panic("key not generated");
        if (k.private_key.cmpNormal(Fr.fromU64(1024)) <= 0) @panic("private key too small");
        return k.private_key;
    }

    pub fn padding(self: *const TablePlayer) Ciphertext {
        return self.crypto.getPadding(self.publicKey());
    }

    pub fn setSealed(self: *TablePlayer, coeffs: []const Fr) void {
        self.sealed = coeffs;
    }

    pub fn indexOfSelf(self: *const TablePlayer, keys: []const PublicKey) usize {
        const me = self.publicKey();
        for (keys, 0..) |k, i| {
            if (k.x.eql(me.x) and k.y.eql(me.y)) return i;
        }
        @panic("player public key not found");
    }

    pub fn fillCoeffs(self: *TablePlayer, out: []Fr) void {
        if (self.sealed.len == 0) {
            @panic("showdown coefficients must come from the host");
        }
        if (self.sealed.len != out.len) @panic("sealed coefficient count");
        for (self.sealed) |c| {
            if (c.eql(Fr.zero())) @panic("host showdown coefficient must be non-zero");
        }
        @memcpy(out, self.sealed);
    }

    /// Blackjack action: status coefficient is host-sealed and non-zero.
    /// The ace coefficient is host-sealed too, and the circuit forces it to 0
    /// unless this player is the dealer.
    pub fn fillActionCoeffs(self: *TablePlayer, out: *[2]Fr) void {
        if (self.sealed.len != 2) @panic("action coefficients must come from the host");
        if (self.sealed[0].eql(Fr.zero())) @panic("action status coefficient must be non-zero");
        out[0] = self.sealed[0];
        out[1] = self.sealed[1];
    }

    pub fn registerProve(self: *TablePlayer) !RegisterOut {
        self.generateKey();
        const pk = self.publicKey();
        const json = try prove.json.registerJson(self.alloc, self.privateKey(), pk);
        defer self.alloc.free(json);
        const proof = try self.engine.proveJson(.register_main, json);
        return .{ .proof = proof, .public_key = pk, .padding = self.padding() };
    }

    pub fn shuffleProve(
        self: *TablePlayer,
        id: CircuitId,
        deck: []const Ciphertext,
        keys: []const PublicKey,
    ) !ShuffleOut {
        var padded: [12]PublicKey = undefined;
        const shuffle_keys = hash.padShuffleKeys(keys, &padded);
        const n = deck.len;
        const h = self.crypto.shuffleHash(deck, keys);
        const matrix = try self.alloc.alloc(u8, n * n);
        defer self.alloc.free(matrix);
        const randomness = try self.alloc.alloc(Fr, n);
        defer self.alloc.free(randomness);
        self.crypto.generateShufflePermutation(n, matrix);
        self.crypto.generateShuffleRandomness(n, randomness);
        const shuffled = try self.alloc.alloc(Ciphertext, n);
        errdefer self.alloc.free(shuffled);
        const perm_hash = self.crypto.shuffle(deck, shuffle_keys, matrix, randomness, shuffled, n);
        const json = try prove.json.shuffleJson(self.alloc, h, deck, shuffle_keys, matrix, randomness);
        defer self.alloc.free(json);
        const proof = try self.engine.proveJson(id, json);
        return .{ .proof = proof, .deck = shuffled, .permutation_hash = perm_hash, .alloc = self.alloc };
    }

    pub fn linearShareProve(
        self: *TablePlayer,
        id: CircuitId,
        deck: []const Ciphertext,
        recipients: []const PublicKey,
        n_actual: u32,
        share_hash: Fr,
    ) !ShareOut {
        const rows_n = recipients.len;
        const cols = deck.len;
        const rand_flat = try self.alloc.alloc(Fr, rows_n * cols);
        defer self.alloc.free(rand_flat);
        const rand_rows = try self.alloc.alloc([]const Fr, rows_n);
        defer self.alloc.free(rand_rows);
        var r: usize = 0;
        while (r < rows_n) : (r += 1) {
            const slice = rand_flat[r * cols .. (r + 1) * cols];
            self.crypto.generateShuffleRandomness(cols, slice);
            rand_rows[r] = slice;
        }
        const flat = try self.alloc.alloc(Ciphertext, rows_n * cols);
        errdefer self.alloc.free(flat);
        const rows = try self.alloc.alloc([]Ciphertext, rows_n);
        errdefer self.alloc.free(rows);
        r = 0;
        while (r < rows_n) : (r += 1) rows[r] = flat[r * cols .. (r + 1) * cols];
        self.crypto.share(deck, recipients, self.privateKey(), rand_rows, rows);
        const json = try prove.json.linearShareJson(
            self.alloc,
            share_hash,
            deck,
            self.publicKey(),
            recipients,
            n_actual,
            self.privateKey(),
            rand_rows,
        );
        defer self.alloc.free(json);
        const proof = try self.engine.proveJson(id, json);
        return .{ .proof = proof, .rows = rows, .flat = flat, .alloc = self.alloc };
    }

    pub fn proveJson(self: *TablePlayer, id: CircuitId, input_json: []const u8) !Proof {
        return self.engine.proveJson(id, input_json);
    }
};

pub fn allocGrid(alloc: std.mem.Allocator, rows_n: usize, cols: usize) !struct { rows: [][]Ciphertext, flat: []Ciphertext } {
    const flat = try alloc.alloc(Ciphertext, rows_n * cols);
    errdefer alloc.free(flat);
    const rows = try alloc.alloc([]Ciphertext, rows_n);
    var i: usize = 0;
    while (i < rows_n) : (i += 1) rows[i] = flat[i * cols .. (i + 1) * cols];
    return .{ .rows = rows, .flat = flat };
}

pub fn allocFrGrid(alloc: std.mem.Allocator, rows_n: usize, cols: usize, rng: *zk.Rng) !struct { rows: [][]Fr, flat: []Fr } {
    const flat = try alloc.alloc(Fr, rows_n * cols);
    errdefer alloc.free(flat);
    const rows = try alloc.alloc([]Fr, rows_n);
    var i: usize = 0;
    while (i < rows_n) : (i += 1) {
        const slice = flat[i * cols .. (i + 1) * cols];
        for (slice) |*c| c.* = rng.scalar253();
        rows[i] = slice;
    }
    return .{ .rows = rows, .flat = flat };
}
