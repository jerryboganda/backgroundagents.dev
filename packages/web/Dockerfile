# syntax=docker/dockerfile:1
#
# The web dashboard as a container: the Next.js standalone server for
# packages/web, with the workspace packages its output traces. Upstream ships
# the web only for Vercel and Cloudflare, so this is the self-hosted Node
# target. The control-plane image is packages/control-plane/Dockerfile.
#
# Build from the repository root. Next inlines NEXT_PUBLIC_* values into the
# client bundle at build time, so the browser-facing URLs are build arguments,
# and a rebuild is needed to change them:
#   docker build -f packages/web/Dockerfile \
#     --build-arg OPEN_INSPECT_REVISION=<commit> \
#     --build-arg NEXT_PUBLIC_WS_URL=wss://cp.ai.polytronx.com \
#     -t open-inspect-web .
#
# Runtime settings (CONTROL_PLANE_URL, SERVICE_AUTH_SECRET, ...) are read from
# the environment when the container starts. Nothing secret is a build argument.

ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
ARG OPEN_INSPECT_REVISION
ARG NEXT_PUBLIC_WS_URL
# Public sandbox provider, inlined into the client. Must match the runtime SANDBOX_PROVIDER.
ARG NEXT_PUBLIC_SANDBOX_PROVIDER=modal
# Fail the build instead of shipping a bundle that points at localhost or an unnamed commit.
RUN test -n "$OPEN_INSPECT_REVISION" \
    || { echo "OPEN_INSPECT_REVISION build argument is required" >&2; exit 1; }
RUN case "$NEXT_PUBLIC_WS_URL" in \
      wss://*|ws://*) ;; \
      *) echo "NEXT_PUBLIC_WS_URL build argument must be a ws:// or wss:// URL" >&2; exit 1 ;; \
    esac
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL} \
    NEXT_PUBLIC_SANDBOX_PROVIDER=${NEXT_PUBLIC_SANDBOX_PROVIDER}
# The workspace is installed from its manifests first, so source edits do not
# invalidate the dependency layer. --ignore-scripts: the root prepare script
# installs git hooks through husky, which a container has no use for.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspace=@open-inspect/shared --workspace=@open-inspect/web
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/
# vitest.config.ts imports this from the root, and next build type-checks it.
COPY scripts/coverage-policy.ts scripts/coverage-policy.ts
RUN npm run build -w @open-inspect/shared \
    && npm run build -w @open-inspect/web

FROM ${NODE_IMAGE} AS runtime
ARG OPEN_INSPECT_REVISION
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# With the monorepo as tracing root, the standalone server is nested at
# packages/web/server.js. Next copies neither the static chunks nor public/
# into the standalone output, so both are placed beside the server here.
COPY --from=build --chown=node:node /app/packages/web/.next/standalone/ ./
COPY --from=build --chown=node:node /app/packages/web/.next/static/ ./packages/web/.next/static/
COPY --from=build --chown=node:node /app/packages/web/public/ ./packages/web/public/
LABEL org.opencontainers.image.title="open-inspect-web" \
      org.opencontainers.image.source="https://github.com/ColeMurray/background-agents" \
      org.opencontainers.image.revision="${OPEN_INSPECT_REVISION}"
USER node
EXPOSE 3000
# Answers while the process serves. Any status below 500 counts, since the
# root route may redirect an unauthenticated browser to sign-in.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/`).then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/web/server.js"]
