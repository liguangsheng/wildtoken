# ── Build stage ──────────────────────────────────────────────────────────────
FROM rust:1.88-bookworm AS builder

WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Cache dependency builds when only app sources change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY src ./src
COPY static ./static
COPY config ./config

# Force rebuild of the real binary after the dummy main above.
RUN touch src/main.rs \
    && cargo build --release \
    && strip target/release/wildtoken

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libsqlite3-0 \
        locales \
        tzdata \
    && sed -i 's/^# \(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && ln -snf /usr/share/zoneinfo/Asia/Singapore /etc/localtime \
    && echo 'Asia/Singapore' > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/target/release/wildtoken /usr/local/bin/wildtoken
COPY --from=builder /src/static ./static
COPY --from=builder /src/config ./config

ENV APP__SERVER__HOST=0.0.0.0 \
    APP__SERVER__PORT=3100 \
    DATABASE_URL=sqlite:/data/wildtoken.db?mode=rwc \
    RUST_LOG=info \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    TZ=Asia/Singapore

VOLUME ["/data"]
EXPOSE 3100

CMD ["wildtoken"]
