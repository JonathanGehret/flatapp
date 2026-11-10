FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY web ./web
RUN cargo build --release --locked

FROM debian:stable-slim
COPY --from=build /app/target/release/flatapp /usr/local/bin/flatapp
ENV PORT=8080 DATABASE_PATH=/data/flatapp.db
VOLUME /data
EXPOSE 8080
CMD ["flatapp"]
