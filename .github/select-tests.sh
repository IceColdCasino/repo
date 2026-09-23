#!/usr/bin/env bash
# Read changed paths on stdin (or --all) and print which proof tests to run.
# A game file, including its zkey and verification key, selects that game.
# A shoe selects the games whose tests prove that shoe. Shared code selects
# every game. Docs and other files select nothing.
set -euo pipefail

ARM=blacksmith-16vcpu-ubuntu-2404-arm
MAC=blacksmith-12vcpu-macos-latest
ORDER=(poker blackjack baccarat war roulette craps keno slots bingo)

declare -A ON=()
TYPECHECK=false

add() {
  local g
  for g in "$@"; do
    if [ "$g" = all ]; then
      add "${ORDER[@]}"
      return
    fi
    ON["$g"]=1
  done
}

note_typecheck() {
  case "$1" in
    *.ts|*.tsx|package.json|bun.lock|bun.lockb|tsconfig.json|tsconfig.*.json)
      TYPECHECK=true
      ;;
  esac
}

classify() {
  local p="$1"
  note_typecheck "$p"
  case "$p" in
    *.md|docs/*) return ;;
  esac
  case "$p" in
    *shuffle_1_deck_52*) add poker baccarat; return ;;
    *shuffle_6_deck_52*) add blackjack war; return ;;
    *shuffle_8_deck_52*) return ;;
    *shuffle_1_deck_37*|*shuffle_1_deck_38*) add roulette; return ;;
    *shuffle_2_dice_6*) add craps; return ;;
    *shuffle_1_deck_80*) add keno; return ;;
    *shuffle_3_reel_22*|*shuffle_5_reel_22*) add slots; return ;;
    *shuffle_1_deck_75*|*shuffle_1_deck_90*) add bingo; return ;;
  esac
  case "$p" in
    *poker*) add poker; return ;;
    *blackjack*) add blackjack; return ;;
    *baccarat*) add baccarat; return ;;
    *roulette*) add roulette; return ;;
    *craps*) add craps; return ;;
    *keno*) add keno; return ;;
    *bingo*) add bingo; return ;;
    *slot*) add slots; return ;;
    *war*) add war; return ;;
  esac
  case "$p" in
    src/*|test/*|libzkcasino/*|circuits/*|zkey/*|package.json|bun.lock|bun.lockb|tsconfig.json|tsconfig.*.json|.github/workflows/tests.yml|.github/select-tests.sh)
      add all
      ;;
  esac
}

if [ "${1:-}" = "--all" ]; then
  add all
  TYPECHECK=true
else
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    classify "$path"
  done
fi

meta() {
  case "$1" in
    poker) TEST=complete_poker_game_with_proofs.test.ts; SET=poker; LFS='zkey/register_main*,zkey/shuffle_1_deck_52_main*,zkey/poker_*' ;;
    blackjack) TEST=complete_blackjack_game_with_proofs.test.ts; SET=blackjack; LFS='zkey/register_main*,zkey/shuffle_6_deck_52_main*,zkey/blackjack_*' ;;
    baccarat) TEST=complete_baccarat_game_with_proofs.test.ts; SET=baccarat; LFS='zkey/register_main*,zkey/shuffle_1_deck_52_main*,zkey/baccarat_*' ;;
    war) TEST=complete_war_game_with_proofs.test.ts; SET=war; LFS='zkey/register_main*,zkey/shuffle_6_deck_52_main*,zkey/war_*' ;;
    roulette) TEST=complete_roulette_game_with_proofs.test.ts; SET=roulette; LFS='zkey/register_main*,zkey/shuffle_1_deck_37_main*,zkey/shuffle_1_deck_38_main*,zkey/roulette_*' ;;
    craps) TEST=complete_craps_game_with_proofs.test.ts; SET=craps; LFS='zkey/register_main*,zkey/shuffle_2_dice_6_main*,zkey/craps_*' ;;
    keno) TEST=complete_keno_game_with_proofs.test.ts; SET=keno; LFS='zkey/register_main*,zkey/shuffle_1_deck_80_main*,zkey/keno_*' ;;
    slots) TEST=complete_slot_game_with_proofs.test.ts; SET=slots; LFS='zkey/register_main*,zkey/shuffle_3_reel_22_main*,zkey/shuffle_5_reel_22_main*,zkey/slot_*' ;;
    bingo) TEST=complete_bingo_game_with_proofs.test.ts; SET=bingo; LFS='zkey/register_main*,zkey/shuffle_1_deck_75_main*,zkey/shuffle_1_deck_90_main*,zkey/bingo_*' ;;
  esac
}

json='['
first=1
selected=()
for g in "${ORDER[@]}"; do
  [ -n "${ON[$g]:-}" ] || continue
  selected+=("$g")
  meta "$g"
  for runner in "$ARM" "$MAC"; do
    [ "$first" = 1 ] || json+=','
    first=0
    json+=$(printf '{"game":"%s","runner":"%s","test":"%s","circuit_set":"%s","lfs":"%s"}' "$g" "$runner" "$TEST" "$SET" "$LFS")
  done
done
json+=']'

if [ "${#selected[@]}" -eq 0 ]; then
  HAS_GAMES=false
  # A skipped job still needs a non-empty matrix value.
  json='[{"game":"none","runner":"blacksmith-4vcpu-ubuntu-2404","test":"none","circuit_set":"poker","lfs":"zkey/register_main*"}]'
else
  HAS_GAMES=true
fi

printf 'typecheck=%s\n' "$TYPECHECK"
printf 'has_games=%s\n' "$HAS_GAMES"
printf 'games=%s\n' "${selected[*]:-}"
printf 'matrix=%s\n' "$json"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  delim="select$(date +%s%N)"
  {
    echo "typecheck=$TYPECHECK"
    echo "has_games=$HAS_GAMES"
    echo "matrix<<$delim"
    echo "$json"
    echo "$delim"
  } >>"$GITHUB_OUTPUT"
fi
