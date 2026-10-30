# syntax=docker/dockerfile:1
# The public Fumadocs site, built from the repository root for the dashboard VPS.
ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/docs/package.json packages/docs/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --install-strategy=nested --workspace=@open-inspect/docs
# Fumadocs' nested plugin needs the docs workspace's Tailwind 4 on its ancestor lookup path.
RUN ln -s /app/packages/docs/node_modules/tailwindcss /app/node_modules/tailwindcss
COPY packages/docs/ packages/docs/
RUN npm run build -w @open-inspect/docs

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/packages/docs/.next/standalone/ ./
COPY --from=build --chown=node:node /app/packages/docs/.next/static/ ./packages/docs/.next/static/
COPY --from=build --chown=node:node /app/packages/docs/public/ ./packages/docs/public/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "packages/docs/server.js"]
