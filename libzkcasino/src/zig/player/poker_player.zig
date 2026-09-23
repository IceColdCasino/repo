const std = @import("std");
const math = @import("poker_math.zig");
const base = @import("player_base.zig");
const table = @import("table_player.zig");
const prove = @import("../prove.zig");

pub const Fr = base.Fr;
pub const Crypto = base.Crypto;
pub const Ciphertext = base.Ciphertext;
pub const PublicKey = base.PublicKey;
pub const MAX_PLAYERS = math.MAX_PLAYERS;
pub const TOTAL_CARDS = math.TOTAL_CARDS;
pub const SHARE_OTHERS = math.SHARE_OTHERS;

pub const shareHash = math.shareHash;
pub const share = math.share;
pub const showdownHash = math.showdownHash;
pub const computeCoefficientCommitment = math.computeCoefficientCommitment;
pub const compareHands = math.compareHands;
pub const computeShowdownOutputHash = math.computeShowdownOutputHash;
pub const computeShareOutputHash = math.computeShareOutputHash;
pub const shareCardMask = math.shareCardMask;
pub const derangement = math.derangement;
pub const generateShufflePermutation = math.generateShufflePermutation;
pub const decryptCards = math.decryptCards;
pub const decryptWithSk = math.decryptWithSk;
pub const decryptCard = math.decryptCard;
pub const lookupCatalog = math.lookupCatalog;
pub const decryptOwnCards = math.decryptOwnCards;

pub const Player = struct {
    table: table.TablePlayer,

    pub fn init(alloc: std.mem.Allocator, engine: *table.Engine, crypto: *Crypto) Player {
        return .{ .table = .init(alloc, engine, crypto) };
    }

    pub fn deinit(self: *Player) void {
        self.table.deinit();
    }

    pub fn generateKey(self: *Player) void {
        self.table.generateKey();
    }

    pub fn registerProve(self: *Player) !table.RegisterOut {
        return self.table.registerProve();
    }

    pub fn shuffleProve(self: *Player, deck: []const Ciphertext, keys: []const PublicKey) !table.ShuffleOut {
        return self.table.shuffleProve(.shuffle_1_deck_52_main, deck, keys);
    }

    pub fn shareProve(
        self: *Player,
        deck: []const Ciphertext,
        others: []const PublicKey,
        n_actual: u32,
    ) !table.ShareOut {
        const mask = shareCardMask(n_actual);
        const h = shareHash(self.table.crypto, deck, mask, self.table.publicKey(), others);
        const alloc = self.table.alloc;
        const grid = try table.allocFrGrid(alloc, others.len, deck.len, &self.table.crypto.rng);
        defer alloc.free(grid.rows);
        defer alloc.free(grid.flat);
        const out_grid = try table.allocGrid(alloc, others.len, deck.len);
        var rand_const: [16][]const Fr = undefined;
        var i: usize = 0;
        while (i < others.len) : (i += 1) rand_const[i] = grid.rows[i];
        share(self.table.crypto, deck, mask, others, self.table.privateKey(), rand_const[0..others.len], out_grid.rows);

        var j = prove.json.Json.init(alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldCts("ciphertext", deck);
        try j.fieldU64("cardMask", mask);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldPoints("publicKeys", others);
        try j.fieldU64("nActualPlayers", n_actual);
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldFrGrid("randomness", rand_const[0..others.len]);
        const json = try j.finish();
        defer alloc.free(json);
        const proof = try self.table.proveJson(.poker_share_hashout_main, json);
        return .{ .proof = proof, .rows = out_grid.rows, .flat = out_grid.flat, .alloc = alloc };
    }

    pub fn showdownProve(
        self: *Player,
        player_index: u64,
        public_keys: []const PublicKey,
        pot_masks: []const Fr,
        cards: []const Ciphertext,
        partials: []const []const Ciphertext,
    ) !struct { proof: table.Proof, winner_masks: [9]u64, commitment: Fr } {
        var coeffs: [9]Fr = undefined;
        self.table.fillCoeffs(&coeffs);
        const commitment = computeCoefficientCommitment(&coeffs);
        const h = showdownHash(self.table.crypto, pot_masks, public_keys, Fr.fromU64(player_index), cards, partials);
        var plaintext: [25]u64 = undefined;
        try decryptCards(self.table.crypto, self.table.privateKey(), pot_masks[0].toU64(), cards, partials, plaintext[0..cards.len]);
        var pot_u64: [16]u64 = undefined;
        var i: usize = 0;
        while (i < pot_masks.len) : (i += 1) pot_u64[i] = pot_masks[i].toU64();
        var winners: [9]u64 = undefined;
        compareHands(pot_u64[0..pot_masks.len], plaintext[0..cards.len], &winners);

        var j = prove.json.Json.init(self.table.alloc);
        errdefer j.deinit();
        try j.begin();
        try j.fieldFr("hash", h);
        try j.fieldPoints("publicKeys", public_keys);
        try j.fieldFrs("potMasks", pot_masks);
        try j.fieldCts("ciphertextCards", cards);
        try j.fieldU64("playerIndex", player_index);
        try j.fieldPoint("publicKey", self.table.publicKey());
        try j.fieldCts2("ciphertextPartials", partials);
        try j.fieldFr("privateKey", self.table.privateKey());
        try j.fieldU64s("plaintextCards", plaintext[0..cards.len]);
        try j.fieldFrs("coefficients", &coeffs);
        const json = try j.finish();
        defer self.table.alloc.free(json);
        const proof = try self.table.proveJson(.poker_showdown_hashout_main, json);
        return .{ .proof = proof, .winner_masks = winners, .commitment = commitment };
    }
};
