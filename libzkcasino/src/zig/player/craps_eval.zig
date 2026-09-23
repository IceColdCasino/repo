pub const CRAPS_LOSE: u32 = 0;
pub const CRAPS_KEEP: u32 = 1;
pub const CRAPS_PAYOUT_SCALE: u32 = 30;
pub const MAX_CRAPS_BETS: usize = 12;

const POINT_NUMS = [_]u32{ 4, 5, 6, 8, 9, 10 };
const HARD_NUMS = [_]u32{ 4, 6, 8, 10 };

pub fn diceTotal(dice: []const u32) u32 {
    return dice[0] + dice[1] + 2;
}

pub fn crapsWin(num: u32, den: u32) u32 {
    return CRAPS_KEEP + (CRAPS_PAYOUT_SCALE * num) / den;
}

fn keepLoseWin(hit: bool, lose: bool, win_code: u32) u32 {
    if (hit) return win_code;
    if (lose) return CRAPS_LOSE;
    return CRAPS_KEEP;
}

pub fn evaluateCraps(dice: []const u32, phase: u32, point: u32) struct { action: u32, point_out: u32 } {
    const total = diceTotal(dice);
    if (phase == 0) {
        if (total == 7 or total == 11) return .{ .action = 0, .point_out = 0 };
        if (total == 2 or total == 3 or total == 12) return .{ .action = 1, .point_out = 0 };
        return .{ .action = 2, .point_out = total };
    }
    if (total == point) return .{ .action = 3, .point_out = point };
    if (total == 7) return .{ .action = 4, .point_out = point };
    return .{ .action = 5, .point_out = point };
}

fn placeWinCode(index: u32) u32 {
    if (index == 0 or index == 5) return crapsWin(9, 5);
    if (index == 1 or index == 4) return crapsWin(7, 5);
    return crapsWin(7, 6);
}

fn trueOddsWinCode(index: u32) u32 {
    if (index == 0 or index == 5) return crapsWin(2, 1);
    if (index == 1 or index == 4) return crapsWin(3, 2);
    return crapsWin(6, 5);
}

fn layOddsWinCode(index: u32) u32 {
    if (index == 0 or index == 5) return crapsWin(1, 2);
    if (index == 1 or index == 4) return crapsWin(2, 3);
    return crapsWin(5, 6);
}

fn evaluatePass(phase: u32, point: u32, total: u32) u32 {
    if (phase == 0) return keepLoseWin(total == 7 or total == 11, total == 2 or total == 3 or total == 12, crapsWin(1, 1));
    return keepLoseWin(total == point, total == 7, crapsWin(1, 1));
}

fn evaluateDontPass(phase: u32, point: u32, total: u32) u32 {
    if (phase == 0) return keepLoseWin(total == 2 or total == 3, total == 7 or total == 11, crapsWin(1, 1));
    return keepLoseWin(total == 7, total == point, crapsWin(1, 1));
}

fn evaluateCome(modifier: u32, total: u32) u32 {
    if (modifier == 0) return keepLoseWin(total == 7 or total == 11, total == 2 or total == 3 or total == 12, crapsWin(1, 1));
    const num = POINT_NUMS[modifier - 1];
    return keepLoseWin(total == num, total == 7, crapsWin(1, 1));
}

fn evaluateDontCome(modifier: u32, total: u32) u32 {
    if (modifier == 0) return keepLoseWin(total == 2 or total == 3, total == 7 or total == 11, crapsWin(1, 1));
    const num = POINT_NUMS[modifier - 1];
    return keepLoseWin(total == 7, total == num, crapsWin(1, 1));
}

fn evaluateOdds(modifier: u32, phase: u32, point: u32, total: u32) u32 {
    const family = modifier / 6;
    const idx = modifier % 6;
    const num = POINT_NUMS[idx];
    const take = trueOddsWinCode(idx);
    const lay = layOddsWinCode(idx);
    if (family == 0) {
        const working = phase == 1 and point == num;
        return keepLoseWin(working and total == num, working and total == 7, take);
    }
    if (family == 1) {
        const working = phase == 1 and point == num;
        return keepLoseWin(working and total == 7, working and total == num, lay);
    }
    if (family == 2) {
        const working = phase == 1;
        return keepLoseWin(working and total == num, working and total == 7, take);
    }
    return keepLoseWin(total == 7, total == num, lay);
}

fn evaluatePlace(modifier: u32, phase: u32, total: u32) u32 {
    return keepLoseWin(phase == 1 and total == POINT_NUMS[modifier], phase == 1 and total == 7, placeWinCode(modifier));
}

fn evaluateBuy(modifier: u32, phase: u32, total: u32) u32 {
    return keepLoseWin(phase == 1 and total == POINT_NUMS[modifier], phase == 1 and total == 7, trueOddsWinCode(modifier));
}

fn evaluateLay(modifier: u32, total: u32) u32 {
    return keepLoseWin(total == 7, total == POINT_NUMS[modifier], layOddsWinCode(modifier));
}

fn evaluateField(total: u32) u32 {
    const hit = total == 2 or total == 3 or total == 4 or total == 9 or total == 10 or total == 11 or total == 12;
    const win = if (total == 2 or total == 12) crapsWin(2, 1) else crapsWin(1, 1);
    return keepLoseWin(hit, !hit, win);
}

fn evaluateProposition(modifier: u32, total: u32) u32 {
    const hits = [_]bool{
        total == 7,
        total == 2 or total == 3 or total == 12,
        total == 11,
        total == 3,
        total == 2,
        total == 12,
        total == 2 or total == 12,
    };
    const wins = [_]u32{ crapsWin(4, 1), crapsWin(7, 1), crapsWin(15, 1), crapsWin(15, 1), crapsWin(30, 1), crapsWin(30, 1), crapsWin(15, 1) };
    return keepLoseWin(hits[modifier], !hits[modifier], wins[modifier]);
}

fn evaluateHardway(modifier: u32, phase: u32, total: u32, is_hard: bool) u32 {
    const num = HARD_NUMS[modifier];
    const working = phase == 1;
    const win = if (modifier == 0 or modifier == 3) crapsWin(7, 1) else crapsWin(9, 1);
    return keepLoseWin(working and is_hard and total == num, working and (total == 7 or (!is_hard and total == num)), win);
}

fn evaluateBig(modifier: u32, phase: u32, total: u32) u32 {
    const num: u32 = if (modifier == 0) 6 else 8;
    return keepLoseWin(phase == 1 and total == num, phase == 1 and total == 7, crapsWin(1, 1));
}

pub fn evaluateBet(typ: u32, modifier: u32, dice: []const u32, phase: u32, point: u32) u32 {
    const total = diceTotal(dice);
    const is_hard = dice[0] == dice[1];
    return switch (typ) {
        0 => evaluatePass(phase, point, total),
        1 => evaluateDontPass(phase, point, total),
        2 => evaluateCome(modifier, total),
        3 => evaluateDontCome(modifier, total),
        4 => evaluateOdds(modifier, phase, point, total),
        5 => evaluatePlace(modifier, phase, total),
        6 => evaluateBuy(modifier, phase, total),
        7 => evaluateLay(modifier, total),
        8 => evaluateField(total),
        9 => evaluateProposition(modifier, total),
        10 => evaluateHardway(modifier, phase, total, is_hard),
        11 => evaluateBig(modifier, phase, total),
        else => 0,
    };
}

pub fn evaluateShowdown(bets: []const [2]u32, dice: []const u32, phase: u32, point: u32, n_actual: usize, out: *[14]u32) void {
    var i: usize = 0;
    while (i < MAX_CRAPS_BETS) : (i += 1) {
        const bet = if (i < bets.len) bets[i] else [2]u32{ 0, 0 };
        out[i] = if (i < n_actual) evaluateBet(bet[0], bet[1], dice, phase, point) else 0;
    }
    const table = evaluateCraps(dice, phase, point);
    out[12] = table.action;
    out[13] = table.point_out;
}
