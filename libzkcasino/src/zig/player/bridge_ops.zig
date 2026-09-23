//! JSON player ops shared by the native `player` command and the host FFI.
//! Keygen, decrypt, and Groth16 stay in Zig. Prove backend is injected.
const std = @import("std");
const poker = @import("poker_math.zig");
const hash = @import("../crypto/hash.zig");
const baby = @import("../crypto/babyjub.zig");
const prove_json = @import("../prove/json.zig");
const Field = @import("../crypto/fr.zig").Fr;

pub const Crypto = poker.Crypto;
pub const Ciphertext = poker.Ciphertext;
pub const PublicKey = poker.PublicKey;
pub const PlayerKey = @import("../crypto/zk_crypto.zig").PlayerKey;
pub const Point = baby.Point;

pub const CATALOG_SIZE: usize = 52;
pub const MAX_DECK: usize = 52;
pub const MAX_KEYS: usize = 12;
pub const MAX_OTHERS: usize = 9;
pub const MAX_PARTIAL_ROWS: usize = 16;

pub const REGISTER_CIRCUIT = "register_main";
pub const SHUFFLE_CIRCUIT = "shuffle_1_deck_52_main";
pub const SHARE_CIRCUIT = "poker_share_hashout_main";
pub const SHOWDOWN_CIRCUIT = "poker_showdown_hashout_main";

pub const ProveOutput = struct {
    proof: []const u8,
    public_signals: []const u8,
    cookie: ?*anyopaque = null,
};

pub const Backend = struct {
    ctx: *anyopaque,
    prove: *const fn (ctx: *anyopaque, circuit: []const u8, input: []const u8) anyerror!ProveOutput,
    free: *const fn (ctx: *anyopaque, out: ProveOutput) void,
};

pub const State = struct {
    alloc: std.mem.Allocator,
    crypto: ?Crypto = null,
    key: ?PlayerKey = null,

    pub fn init(alloc: std.mem.Allocator) State {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *State) void {
        if (self.crypto) |*c| c.deinit(self.alloc);
        self.crypto = null;
        self.key = null;
    }

    pub fn cryptoPtr(self: *State) !*Crypto {
        if (self.crypto == null) {
            self.crypto = try Crypto.init(self.alloc, CATALOG_SIZE, 0);
        }
        return &self.crypto.?;
    }
};

/// Caller owns the returned buffer (`alloc.free`).
pub fn dispatch(self: *State, payload: []const u8, backend: Backend) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, self.alloc, payload, .{});
    defer parsed.deinit();
    const root = parsed.value;
    if (root != .object) return error.InvalidPayload;
    const op = asDec(root.object.get("op") orelse return error.MissingOp);
    const crypto = try self.cryptoPtr();

    var w = Writer.init(self.alloc);
    errdefer w.deinit();

    if (std.mem.eql(u8, op, "ping")) {
        try w.raw("{\"ok\":true,\"backend\":\"zig\"}");
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "key")) {
        try writeKey(self, crypto, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "register")) {
        try writeRegister(self, crypto, root, &w, backend);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "shuffle")) {
        try writeShuffle(self, crypto, root, &w, backend);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "share")) {
        try writeShare(self, crypto, root, &w, backend);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "showdown")) {
        try writeShowdown(self, crypto, root, &w, backend);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "decrypt")) {
        try writeDecrypt(self, crypto, root, &w);
        return w.toOwned();
    }
    if (std.mem.eql(u8, op, "calc")) {
        const calc = @import("calc.zig");
        try calc.run(self.alloc, crypto, 0, root, &w);
        return w.toOwned();
    }
    return error.UnknownPlayerOp;
}

fn writeKey(self: *State, crypto: *Crypto, root: std.json.Value, w: *Writer) !void {
    const key = try ensureKey(self, crypto, root);
    try writeKeyBody(crypto, key, w);
}

fn writeRegister(self: *State, crypto: *Crypto, root: std.json.Value, w: *Writer, backend: Backend) !void {
    const key = try ensureKey(self, crypto, root);
    const padding = crypto.getPadding(key.public_key);
    const input = try prove_json.registerJson(self.alloc, key.private_key, key.public_key);
    defer self.alloc.free(input);
    const proved = try backend.prove(backend.ctx, REGISTER_CIRCUIT, input);
    defer backend.free(backend.ctx, proved);

    try w.beginObj();
    try w.okTrue();
    try w.embedProof(proved.proof, proved.public_signals);
    try w.key("privateKey");
    try w.fr(key.private_key);
    try w.key("publicKey");
    try w.point(key.public_key);
    try w.key("padding");
    try w.ct(padding);
    try w.endObj();
}

fn writeShuffle(self: *State, crypto: *Crypto, root: std.json.Value, w: *Writer, backend: Backend) !void {
    _ = try ensureKey(self, crypto, root);
    const deck_n = try parseCtList(self.alloc, root.object.get("deck") orelse return error.MissingDeck);
    defer self.alloc.free(deck_n.ptr[0..deck_n.len]);
    if (deck_n.len == 0 or deck_n.len > MAX_DECK) return error.InvalidDeck;
    const keys_n = try parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    var padded: [12]PublicKey = undefined;
    const keys = hash.padShuffleKeys(keys_n.buf[0..keys_n.len], &padded);

    var matrix_buf: [MAX_DECK * MAX_DECK]u8 = undefined;
    const matrix = matrix_buf[0 .. deck_n.len * deck_n.len];
    crypto.generateShufflePermutation(deck_n.len, matrix);

    var rand_buf: [MAX_DECK]Field = undefined;
    const randomness = rand_buf[0..deck_n.len];
    crypto.generateShuffleRandomness(deck_n.len, randomness);

    var out_buf: [MAX_DECK]Ciphertext = undefined;
    const out = out_buf[0..deck_n.len];
    const perm_hash = crypto.shuffle(deck_n.ptr[0..deck_n.len], keys, matrix, randomness, out, deck_n.len);
    const input_hash = crypto.shuffleHash(deck_n.ptr[0..deck_n.len], keys_n.buf[0..keys_n.len]);

    const input = try prove_json.shuffleJson(self.alloc, input_hash, deck_n.ptr[0..deck_n.len], keys, matrix, randomness);
    defer self.alloc.free(input);
    const proved = try backend.prove(backend.ctx, SHUFFLE_CIRCUIT, input);
    defer backend.free(backend.ctx, proved);

    try w.beginObj();
    try w.okTrue();
    try w.embedProof(proved.proof, proved.public_signals);
    try w.key("permutationHash");
    try w.fr(perm_hash);
    try w.key("deck");
    try w.cts(out);
    try w.endObj();
}

fn writeShare(self: *State, crypto: *Crypto, root: std.json.Value, w: *Writer, backend: Backend) !void {
    const key = try requireKey(self, crypto, root);
    const deck_n = try parseCtList(self.alloc, root.object.get("deck") orelse return error.MissingDeck);
    defer self.alloc.free(deck_n.ptr[0..deck_n.len]);
    const others_n = try parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    if (others_n.len != poker.SHARE_OTHERS) return error.ShareOthersCount;
    const n_actual = try parseU64(root.object.get("nActualPlayers") orelse return error.MissingNActual);
    const mask = poker.shareCardMask(@intCast(n_actual));

    const rows = others_n.len;
    const cols = deck_n.len;
    const flat = try self.alloc.alloc(Field, rows * cols);
    defer self.alloc.free(flat);
    var row_ptrs: [MAX_OTHERS][]Field = undefined;
    var i: usize = 0;
    while (i < rows) : (i += 1) {
        row_ptrs[i] = flat[i * cols ..][0..cols];
        crypto.generateShuffleRandomness(cols, row_ptrs[i]);
    }

    const out_flat = try self.alloc.alloc(Ciphertext, rows * cols);
    defer self.alloc.free(out_flat);
    var out_rows: [MAX_OTHERS][]Ciphertext = undefined;
    i = 0;
    while (i < rows) : (i += 1) {
        out_rows[i] = out_flat[i * cols ..][0..cols];
    }
    var rand_const: [MAX_OTHERS][]const Field = undefined;
    i = 0;
    while (i < rows) : (i += 1) rand_const[i] = row_ptrs[i];
    poker.share(
        crypto,
        deck_n.ptr[0..deck_n.len],
        mask,
        others_n.buf[0..others_n.len],
        key.private_key,
        rand_const[0..rows],
        out_rows[0..rows],
    );
    const h = poker.shareHash(
        crypto,
        deck_n.ptr[0..deck_n.len],
        mask,
        key.public_key,
        others_n.buf[0..others_n.len],
    );

    var j = prove_json.Json.init(self.alloc);
    errdefer j.deinit();
    try j.begin();
    try j.fieldFr("hash", h);
    try j.fieldCts("ciphertext", deck_n.ptr[0..deck_n.len]);
    try j.fieldU64("cardMask", mask);
    try j.fieldPoint("publicKey", key.public_key);
    try j.fieldPoints("publicKeys", others_n.buf[0..others_n.len]);
    try j.fieldU64("nActualPlayers", n_actual);
    try j.fieldFr("privateKey", key.private_key);
    try j.fieldFrGrid("randomness", rand_const[0..rows]);
    const input = try j.finish();
    defer self.alloc.free(input);
    const proved = try backend.prove(backend.ctx, SHARE_CIRCUIT, input);
    defer backend.free(backend.ctx, proved);

    try w.beginObj();
    try w.okTrue();
    try w.embedProof(proved.proof, proved.public_signals);
    try w.key("ciphertexts");
    try w.ctGrid(out_rows[0..rows]);
    try w.endObj();
}

fn writeShowdown(self: *State, crypto: *Crypto, root: std.json.Value, w: *Writer, backend: Backend) !void {
    const key = try requireKey(self, crypto, root);
    const keys_n = try parsePointList(root.object.get("publicKeys") orelse return error.MissingPublicKeys);
    const player_index = try parseU64(root.object.get("playerIndex") orelse return error.MissingPlayerIndex);
    const cards_n = try parseCtList(self.alloc, root.object.get("cards") orelse return error.MissingCards);
    defer self.alloc.free(cards_n.ptr[0..cards_n.len]);

    var pot_fr: [16]Field = undefined;
    const pot_n = try parseFrListCount(root.object.get("potMasks") orelse return error.MissingPotMasks, &pot_fr);

    var row_storage: [MAX_PARTIAL_ROWS][52]Ciphertext = undefined;
    var row_slices: [MAX_PARTIAL_ROWS][]const Ciphertext = undefined;
    const partial_rows = try parseCtGrid(root.object.get("partials") orelse return error.MissingPartials, &row_storage, &row_slices);

    const do_prove = parseBool(root.object.get("prove"), true);
    var coeffs: [9]Field = undefined;
    var have_coeffs = false;
    if (root.object.get("coefficients")) |raw_coeffs| {
        try parseFrList(raw_coeffs, &coeffs);
        for (coeffs) |c| {
            if (c.eql(Field.zero())) return error.ZeroCoefficient;
        }
        have_coeffs = true;
    } else if (do_prove) {
        return error.MissingHostCoefficients;
    }
    const commitment = if (have_coeffs) poker.computeCoefficientCommitment(&coeffs) else Field.zero();
    const h = poker.showdownHash(
        crypto,
        pot_fr[0..pot_n],
        keys_n.buf[0..keys_n.len],
        Field.fromU64(player_index),
        cards_n.ptr[0..cards_n.len],
        row_slices[0..partial_rows],
    );

    var plaintext: [52]u64 = undefined;
    try poker.decryptCards(
        crypto,
        key.private_key,
        pot_fr[0].toU64(),
        cards_n.ptr[0..cards_n.len],
        row_slices[0..partial_rows],
        plaintext[0..cards_n.len],
    );
    var pot_u64: [16]u64 = undefined;
    var i: usize = 0;
    while (i < pot_n) : (i += 1) pot_u64[i] = pot_fr[i].toU64();
    var winners: [9]u64 = undefined;
    poker.compareHands(pot_u64[0..pot_n], plaintext[0..cards_n.len], &winners);

    try w.beginObj();
    try w.okTrue();
    if (do_prove) {
        var j = prove_json.Json.init(self.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", keys_n.buf[0..keys_n.len]);
        try j.fieldFrs("potMasks", pot_fr[0..pot_n]);
        try j.fieldCts("ciphertextCards", cards_n.ptr[0..cards_n.len]);
        try j.fieldU64("playerIndex", player_index);
        try j.fieldPoint("publicKey", key.public_key);
        try j.fieldCts2("ciphertextPartials", row_slices[0..partial_rows]);
        try j.fieldFr("privateKey", key.private_key);
        try j.fieldU64s("plaintextCards", plaintext[0..cards_n.len]);
        try j.fieldFrs("coefficients", &coeffs);
        const input = try j.finish();
        defer self.alloc.free(input);
        const proved = try backend.prove(backend.ctx, SHOWDOWN_CIRCUIT, input);
        defer backend.free(backend.ctx, proved);
        try w.embedProof(proved.proof, proved.public_signals);
    }
    try w.key("winnerMasks");
    try w.u64s(winners[0..pot_n]);
    try w.key("coefficientCommitment");
    try w.fr(commitment);
    try w.key("publicKey");
    try w.point(key.public_key);
    try w.endObj();
}

fn writeDecrypt(self: *State, crypto: *const Crypto, root: std.json.Value, w: *Writer) !void {
    const key = try requireKey(self, crypto, root);
    const cards_n = try parseCtList(self.alloc, root.object.get("cards") orelse return error.MissingCards);
    defer self.alloc.free(cards_n.ptr[0..cards_n.len]);

    try w.beginObj();
    try w.okTrue();
    try w.key("cardIndices");
    try w.beginArr();
    var first = true;
    if (root.object.get("partials")) |partials_val| {
        if (partials_val != .array) return error.InvalidPartials;
        if (partials_val.array.items.len != cards_n.len) return error.PartialCount;
        for (partials_val.array.items, 0..) |row, i| {
            var received: [16]Ciphertext = undefined;
            const n = try parseCtListInto(row, &received);
            const idx = crypto.decryptFromPartials(key.private_key, cards_n.ptr[i], received[0..n]);
            if (!first) try w.raw(",");
            first = false;
            try w.writeI64(idx);
        }
    } else {
        var i: usize = 0;
        while (i < cards_n.len) : (i += 1) {
            const idx = crypto.decryptWithSk(key.private_key, cards_n.ptr[i]);
            if (!first) try w.raw(",");
            first = false;
            try w.writeI64(idx);
        }
    }
    try w.endArr();
    try w.endObj();
}

fn writeKeyBody(crypto: *const Crypto, key: PlayerKey, w: *Writer) !void {
    const padding = crypto.getPadding(key.public_key);
    try w.beginObj();
    try w.okTrue();
    try w.key("privateKey");
    try w.fr(key.private_key);
    try w.key("publicKey");
    try w.point(key.public_key);
    try w.key("padding");
    try w.ct(padding);
    try w.endObj();
}

fn ensureKey(self: *State, crypto: *Crypto, root: std.json.Value) !PlayerKey {
    if (root.object.get("privateKey")) |raw| {
        const sk = try parseFr(raw);
        if (sk.cmpNormal(Field.fromU64(1024)) <= 0) return error.PrivateKeyTooSmall;
        const key: PlayerKey = .{ .private_key = sk, .public_key = baby.mulBase8(sk) };
        self.key = key;
        return key;
    }
    if (self.key) |k| return k;
    const key = crypto.generatePlayerKey();
    self.key = key;
    return key;
}

fn requireKey(self: *State, crypto: *const Crypto, root: std.json.Value) !PlayerKey {
    _ = crypto;
    if (root.object.get("privateKey")) |raw| {
        const sk = try parseFr(raw);
        if (sk.cmpNormal(Field.fromU64(1024)) <= 0) return error.PrivateKeyTooSmall;
        const key: PlayerKey = .{ .private_key = sk, .public_key = baby.mulBase8(sk) };
        self.key = key;
        return key;
    }
    return self.key orelse error.KeyNotGenerated;
}

pub const CtList = struct { ptr: [*]Ciphertext, len: usize };
pub const PointList = struct { buf: [MAX_KEYS]PublicKey, len: usize };

pub fn parseCtList(alloc: std.mem.Allocator, value: std.json.Value) !CtList {
    if (value != .array) return error.InvalidDeck;
    const items = value.array.items;
    const out = try alloc.alloc(Ciphertext, items.len);
    errdefer alloc.free(out);
    for (items, 0..) |item, i| out[i] = try parseCt(item);
    return .{ .ptr = out.ptr, .len = items.len };
}

pub fn parseCtListInto(value: std.json.Value, out: []Ciphertext) !usize {
    if (value != .array) return error.InvalidCiphertexts;
    if (value.array.items.len > out.len) return error.TooManyCiphertexts;
    for (value.array.items, 0..) |item, i| out[i] = try parseCt(item);
    return value.array.items.len;
}

pub fn parsePointList(value: std.json.Value) !PointList {
    if (value != .array) return error.InvalidPublicKeys;
    if (value.array.items.len > MAX_KEYS) return error.TooManyKeys;
    var out: PointList = .{ .buf = undefined, .len = value.array.items.len };
    for (value.array.items, 0..) |item, i| out.buf[i] = try parsePoint(item);
    return out;
}

fn parseCtGrid(
    value: std.json.Value,
    storage: *[MAX_PARTIAL_ROWS][52]Ciphertext,
    slices: *[MAX_PARTIAL_ROWS][]const Ciphertext,
) !usize {
    if (value != .array) return error.InvalidPartials;
    if (value.array.items.len > MAX_PARTIAL_ROWS) return error.TooManyPartialRows;
    for (value.array.items, 0..) |row, r| {
        const n = try parseCtListInto(row, storage[r][0..]);
        slices[r] = storage[r][0..n];
    }
    return value.array.items.len;
}

pub fn parseFrList(value: std.json.Value, out: []Field) !void {
    if (value != .array) return error.InvalidFrList;
    if (value.array.items.len != out.len) return error.FrListSize;
    for (value.array.items, 0..) |item, i| out[i] = try parseFr(item);
}

pub fn parseFrListCount(value: std.json.Value, out: []Field) !usize {
    if (value != .array) return error.InvalidFrList;
    if (value.array.items.len > out.len) return error.FrListSize;
    for (value.array.items, 0..) |item, i| out[i] = try parseFr(item);
    return value.array.items.len;
}

pub fn parseCt(value: std.json.Value) !Ciphertext {
    const arr = try four(value);
    return .{
        .c0x = Field.fromDec(arr[0]),
        .c0y = Field.fromDec(arr[1]),
        .c1x = Field.fromDec(arr[2]),
        .c1y = Field.fromDec(arr[3]),
    };
}

pub fn parsePoint(value: std.json.Value) !PublicKey {
    const arr = try two(value);
    return .{ .x = Field.fromDec(arr[0]), .y = Field.fromDec(arr[1]) };
}

pub fn parseFr(value: std.json.Value) !Field {
    return switch (value) {
        .integer => |n| Field.fromI64(@intCast(n)),
        .string, .number_string => Field.fromDec(asDec(value)),
        else => error.InvalidFr,
    };
}

pub fn parseU64(value: std.json.Value) !u64 {
    return switch (value) {
        .integer => |n| if (n < 0) error.InvalidU64 else @intCast(n),
        .string, .number_string => std.fmt.parseInt(u64, asDec(value), 10),
        else => error.InvalidU64,
    };
}

pub fn parseBool(value: ?std.json.Value, default: bool) bool {
    const v = value orelse return default;
    return switch (v) {
        .bool => |b| b,
        else => default,
    };
}

fn four(value: std.json.Value) ![4][]const u8 {
    if (value != .array or value.array.items.len != 4) return error.ExpectedFour;
    return .{
        asDec(value.array.items[0]),
        asDec(value.array.items[1]),
        asDec(value.array.items[2]),
        asDec(value.array.items[3]),
    };
}

fn two(value: std.json.Value) ![2][]const u8 {
    if (value != .array or value.array.items.len != 2) return error.ExpectedTwo;
    return .{ asDec(value.array.items[0]), asDec(value.array.items[1]) };
}

pub fn asDec(value: std.json.Value) []const u8 {
    return switch (value) {
        .string => |s| s,
        .number_string => |s| s,
        else => "0",
    };
}

pub const Writer = struct {
    alloc: std.mem.Allocator,
    buf: std.ArrayList(u8) = .empty,
    first: bool = true,

    pub fn init(alloc: std.mem.Allocator) Writer {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *Writer) void {
        self.buf.deinit(self.alloc);
    }

    pub fn toOwned(self: *Writer) ![]u8 {
        return self.buf.toOwnedSlice(self.alloc);
    }

    pub fn raw(self: *Writer, s: []const u8) !void {
        try self.buf.appendSlice(self.alloc, s);
    }

    pub fn okTrue(self: *Writer) !void {
        try self.raw("\"ok\":true");
        self.first = false;
    }

    pub fn beginObj(self: *Writer) !void {
        try self.raw("{");
        self.first = true;
    }

    pub fn endObj(self: *Writer) !void {
        try self.raw("}");
    }

    pub fn beginArr(self: *Writer) !void {
        try self.raw("[");
        self.first = true;
    }

    pub fn endArr(self: *Writer) !void {
        try self.raw("]");
    }

    pub fn key(self: *Writer, name: []const u8) !void {
        if (!self.first) try self.raw(",");
        self.first = false;
        try self.raw("\"");
        try self.raw(name);
        try self.raw("\":");
    }

    pub fn quote(self: *Writer, s: []const u8) !void {
        try self.raw("\"");
        try self.raw(s);
        try self.raw("\"");
    }

    pub fn fr(self: *Writer, v: Field) !void {
        var dec: [80]u8 = undefined;
        try self.quote(v.toDec(&dec));
    }

    pub fn writeU64(self: *Writer, v: u64) !void {
        var tmp: [32]u8 = undefined;
        try self.quote(std.fmt.bufPrint(&tmp, "{d}", .{v}) catch unreachable);
    }

    pub fn writeI64(self: *Writer, v: isize) !void {
        var tmp: [32]u8 = undefined;
        try self.quote(std.fmt.bufPrint(&tmp, "{d}", .{v}) catch unreachable);
    }

    pub fn jsonStr(self: *Writer, s: []const u8) !void {
        const encoded = try std.json.Stringify.valueAlloc(self.alloc, s, .{});
        defer self.alloc.free(encoded);
        try self.raw(encoded);
    }

    pub fn embedProof(self: *Writer, proof: []const u8, public_signals: []const u8) !void {
        try self.key("proofJson");
        try self.jsonStr(proof);
        try self.key("publicSignalsJson");
        try self.jsonStr(public_signals);
    }

    pub fn point(self: *Writer, p: Point) !void {
        const save = self.first;
        try self.beginArr();
        try self.fr(p.x);
        try self.raw(",");
        try self.fr(p.y);
        try self.endArr();
        self.first = save;
    }

    pub fn ct(self: *Writer, c: Ciphertext) !void {
        const save = self.first;
        try self.beginArr();
        inline for (c.limbs()) |limb| {
            if (!self.first) try self.raw(",");
            self.first = false;
            try self.fr(limb);
        }
        try self.endArr();
        self.first = save;
    }

    pub fn u64s(self: *Writer, vs: []const u64) !void {
        const save = self.first;
        try self.beginArr();
        for (vs, 0..) |v, i| {
            if (i != 0) try self.raw(",");
            try self.writeU64(v);
        }
        try self.endArr();
        self.first = save;
    }

    pub fn cts(self: *Writer, vs: []const Ciphertext) !void {
        const save = self.first;
        try self.beginArr();
        for (vs, 0..) |c, i| {
            if (i != 0) try self.raw(",");
            try self.ct(c);
        }
        try self.endArr();
        self.first = save;
    }

    pub fn ctGrid(self: *Writer, rows: []const []Ciphertext) !void {
        const save = self.first;
        try self.beginArr();
        for (rows, 0..) |row, i| {
            if (i != 0) try self.raw(",");
            try self.cts(row);
        }
        try self.endArr();
        self.first = save;
    }
};
