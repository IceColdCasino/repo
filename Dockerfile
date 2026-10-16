# House player images for every game that pays from the dealer pool.
# Poker and bingo are not built here.
#
#   docker build --target keno -t icecold-house-keno .
#
# Targets: baccarat, blackjack, war, roulette, craps, keno, slots.
# Linux/arm64 only. Mount zkeys at /opt/zkcasino/zkey (ZK_ZKEY_DIR).
# Bet circuits (roulette_bet_*, craps_bet, keno_bet) are not linked.
# Blackjack action and slot share stay.

FROM --platform=linux/arm64 debian:bookworm-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils unzip build-essential python3 \
        libgmp-dev libc++-dev libc++abi-dev \
    && rm -rf /var/lib/apt/lists/*
ARG ZIG_VERSION=0.16.0
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-aarch64-linux-${ZIG_VERSION}.tar.xz" \
        | tar -xJ -C /opt \
    && ln -sf "/opt/zig-aarch64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig
ARG RAPIDSNARK_VERSION=v0.0.8
RUN curl -fsSL -o /tmp/rapidsnark.zip \
        "https://github.com/iden3/rapidsnark/releases/download/${RAPIDSNARK_VERSION}/rapidsnark-linux-arm64-${RAPIDSNARK_VERSION}.zip" \
    && unzip /tmp/rapidsnark.zip -d /tmp/rapidsnark \
    && find /tmp/rapidsnark -name librapidsnark.so -exec cp {} /opt/librapidsnark.so \; \
    && rm -rf /tmp/rapidsnark /tmp/rapidsnark.zip

FROM toolchain AS build-common
WORKDIR /src/libzkcasino
COPY libzkcasino /src/libzkcasino
RUN zig build player-lib player-bridge-lib -Doptimize=ReleaseFast -Dhouse=true -Dcircuit-set=baccarat

FROM build-common AS build-baccarat
# One circuit at a time. A ReleaseFast compile of these sources is killed
# when several translation units run together.
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=baccarat -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/baccarat_share.dat \
        src/zig/dat/baccarat_showdown.dat \
        src/zig/dat/shuffle_1_deck_52.dat \
        src/zig/dat/shuffle_6_deck_52.dat \
        src/zig/dat/shuffle_8_deck_52.dat \
        /opt/zkcasino/dat/

FROM build-common AS build-blackjack
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=blackjack -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/blackjack_share.dat \
        src/zig/dat/blackjack_action.dat \
        src/zig/dat/blackjack_showdown.dat \
        src/zig/dat/shuffle_1_deck_52.dat \
        src/zig/dat/shuffle_6_deck_52.dat \
        src/zig/dat/shuffle_8_deck_52.dat \
        /opt/zkcasino/dat/

FROM build-common AS build-war
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=war -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/war_share.dat \
        src/zig/dat/war_showdown.dat \
        src/zig/dat/shuffle_1_deck_52.dat \
        src/zig/dat/shuffle_6_deck_52.dat \
        src/zig/dat/shuffle_8_deck_52.dat \
        /opt/zkcasino/dat/

FROM build-common AS build-roulette
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=roulette -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/roulette_share.dat \
        src/zig/dat/roulette_showdown_37.dat \
        src/zig/dat/roulette_showdown_38.dat \
        src/zig/dat/shuffle_1_deck_37.dat \
        src/zig/dat/shuffle_1_deck_38.dat \
        /opt/zkcasino/dat/

FROM build-common AS build-craps
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=craps -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/craps_share.dat \
        src/zig/dat/craps_showdown.dat \
        src/zig/dat/shuffle_2_dice_6.dat \
        /opt/zkcasino/dat/

FROM build-common AS build-keno
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=keno -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/keno_share.dat \
        src/zig/dat/keno_showdown.dat \
        src/zig/dat/shuffle_1_deck_80.dat \
        /opt/zkcasino/dat/

FROM build-common AS build-slots
RUN zig build -j1 -Doptimize=ReleaseFast -Dcircuit-set=slots -Dhouse=true \
    && mkdir -p /opt/zkcasino/lib /opt/zkcasino/dat \
    && cp -a zig-out/lib/*.so /opt/zkcasino/lib/ \
    && cp /opt/librapidsnark.so /opt/zkcasino/lib/librapidsnark.so \
    && cp src/zig/dat/register.dat \
        src/zig/dat/slot_share_3_reel.dat \
        src/zig/dat/slot_share_5_reel.dat \
        src/zig/dat/slot_showdown_3_reel.dat \
        src/zig/dat/slot_showdown_5_reel.dat \
        src/zig/dat/shuffle_3_reel_22.dat \
        src/zig/dat/shuffle_5_reel_22.dat \
        /opt/zkcasino/dat/

FROM --platform=linux/arm64 oven/bun:1.3.14 AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libgmp10 libc++1 libc++abi1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY rust/light-casino/idl/light_casino.json ./rust/light-casino/idl/light_casino.json
ENV ZKCASINO_LIB_DIR=/opt/zkcasino/lib \
    ZKCASINO_DAT_ROOT=/opt/zkcasino/dat \
    RAPIDSNARK_LIB=/opt/zkcasino/lib/librapidsnark.so \
    ZK_ZKEY_DIR=/opt/zkcasino/zkey \
    LD_LIBRARY_PATH=/opt/zkcasino/lib

FROM runtime-base AS baccarat
COPY --from=build-baccarat /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/baccarat.ts"]

FROM runtime-base AS blackjack
COPY --from=build-blackjack /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/blackjack.ts"]

FROM runtime-base AS war
COPY --from=build-war /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/war.ts"]

FROM runtime-base AS roulette
COPY --from=build-roulette /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/roulette.ts"]

FROM runtime-base AS craps
COPY --from=build-craps /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/craps.ts"]

FROM runtime-base AS keno
COPY --from=build-keno /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/keno.ts"]

FROM runtime-base AS slots
COPY --from=build-slots /opt/zkcasino /opt/zkcasino
CMD ["bun", "src/house/slots.ts"]

FROM runtime-base AS house
CMD ["bun", "-e", "throw new Error('docker build --target baccarat|blackjack|war|roulette|craps|keno|slots')"]
