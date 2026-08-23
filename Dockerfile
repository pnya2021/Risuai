# ------------------------------------------------------------------------------------------

FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Copy dependency-related file
COPY package.json .
COPY pnpm-lock.yaml .

RUN corepack enable
RUN corepack install --global pnpm@10.34.1

# ------------------------------------------------------------------------------------------

FROM base AS deps
ARG TARGETARCH
# Install only prod deps
RUN --mount=type=cache,id=pnpm-prod-${TARGETARCH},target=/pnpm/store,sharing=locked pnpm install --prod --frozen-lockfile

# ------------------------------------------------------------------------------------------

FROM --platform=$BUILDPLATFORM node:24-slim AS builder
ARG BUILDARCH
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
COPY package.json .
COPY pnpm-lock.yaml .
RUN corepack enable
RUN corepack install --global pnpm@10.34.1
# Install including dev deps
RUN --mount=type=cache,id=pnpm-build-${BUILDARCH},target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ------------------------------------------------------------------------------------------

FROM base AS runtime
WORKDIR /app

COPY package.json .
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 6001

CMD ["pnpm", "runserver"]

# ------------------------------------------------------------------------------------------
