# The VPS executor as a container: the HTTP service in src/ that starts gVisor (runsc) sandboxes
# through the engine on its host. It runs as the image's non-root node user. The image starts no
# Docker daemon; the executor reaches the host's daemon through the socket that
# deploy/polytronx/compose.executor.yml mounts.
#
# Build from this directory, so the context is the package alone:
#   docker build -t open-inspect-vps-executor packages/vps-executor
#
# The base image is pinned by digest, and it is the same value as NODE_IMAGE in
# deploy/polytronx/pins.env. The vps-executor CI job checks that they match.

ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE}

# The docker CLI is the only part of docker this image uses. docker.io is the Debian package that
# provides it; --no-install-recommends keeps optional extras out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src

# State lives on a volume that compose mounts here. The code stays root-owned, so the process
# cannot change it.
RUN mkdir -p /var/lib/vps-executor && chown node:node /var/lib/vps-executor

# The docker CLI writes its config under HOME by default. Compose mounts /tmp as tmpfs, so point it there.
ENV DOCKER_CONFIG=/tmp/docker
# Emptying a large workspace unlinks tens of thousands of files; the default four filesystem threads made that slow.
ENV UV_THREADPOOL_SIZE=16

USER node
EXPOSE 8787
CMD ["node", "src/index.ts"]
