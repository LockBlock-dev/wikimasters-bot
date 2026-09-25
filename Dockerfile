# Build:  docker build -t wikimasters-bot .
# Run:    docker run --rm -it --env-file .env -v wm-state:/app/state wikimasters-bot
#         (override the command for one-shots: docker run --rm --env-file .env wikimasters-bot status)

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY tsconfig.json ./
COPY src/ ./src/

RUN bun install --frozen-lockfile
RUN bunx tsc --noEmit
RUN bun build src/index.ts --outdir ./dist --target bun



FROM oven/bun:${BUN_VERSION}-alpine AS runtime

WORKDIR /app

COPY --from=build /app/dist/index.js ./dist/index.js
# Bot state (.session.json, .bid-spend.json, .notifications-seen.json) is
# resolved next to the bundle, i.e. here in /app. Bind-mount the files you
# want to persist (touch them first so Docker doesn't create directories):
#   -v ./data/.session.json:/app/.session.json -v ./data/.bid-spend.json:/app/.bid-spend.json

ENTRYPOINT ["bun", "dist/index.js"]
CMD ["telegram"]
