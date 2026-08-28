FROM docker.io/cloudflare/sandbox:next@sha256:712d12b2bd6f91ae66d83cebd9f7a0bfa684ae3e3100299c315d20d2ce38b8b1

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY runner ./runner
