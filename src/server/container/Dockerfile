# Claude Station per-project container image.
#
# Derived from the proven template at
# external-project-O-linux's own Dockerfile.claude (do not edit that copy). Differences: no tmux/session wrapper (Claude Station drives the
# CLI over `docker exec -i` stdio, not an interactive terminal), and no
# ENTRYPOINT that runs claude (the container idles; sessions are exec'd in).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl wget git jq ripgrep \
      python3 python3-pip python3-venv \
      grep findutils coreutils file tree procps \
      ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI only (no daemon). Useless unless the project explicitly opts into
# the docker-socket mount — which is off by default, see container-manager.ts.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# BUG-035 — `uv`/`uvx` (astral.sh). MCP servers are spawned by the CLI, which
# for `isolation: container` means IN HERE. Without uv the CLI just reports
# `mcp_servers:[{serena, failed}]` in system:init and runs on without the tools
# (npx-based Playwright and the bind-mounted browser shim kept working, which is
# exactly why Serena looked like the only broken one). Installed system-wide so
# it survives the HOME switch below.
RUN curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uvx --version

# BUG-107 — PROVISIONED TOOLING, BAKED IN, PINNED, FETCHED ONCE.
#
# Serena used to be launched as `uvx --from git+https://github.com/oraios/serena`
# — which re-resolved a MUTABLE git HEAD over the network at every session
# start. That is a supply-chain exposure on the hot path (and, offline, a hard
# session-start failure). Here it becomes a normal registry install of an exact
# version, done once at build time into a durable layer; a session merely execs
# /usr/local/bin/serena.
#
# The version is NOT written here. provision.json is the single source of truth,
# it is COPYed in so the running image can be asked what it was built with, and
# src/server/provisioning.ts hashes it into the image tag so editing it actually
# produces a different artifact instead of a silently ignored comment.
COPY provision.json /etc/claude-station/provision.json
RUN set -eux; \
    SERENA_PKG="$(jq -r '.tools.serena.package' /etc/claude-station/provision.json)"; \
    SERENA_VER="$(jq -r '.tools.serena.version' /etc/claude-station/provision.json)"; \
    test -n "${SERENA_PKG}" && test "${SERENA_PKG}" != "null"; \
    test -n "${SERENA_VER}" && test "${SERENA_VER}" != "null"; \
    UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
      uv tool install "${SERENA_PKG}==${SERENA_VER}"; \
    chmod -R a+rX /opt/uv-tools; \
    serena --version | grep -F "${SERENA_VER}"

# BUG-108 — Playwright's MCP server, PINNED and BAKED, same policy as Serena.
#
# This used to be launched as `npx -y @playwright/mcp@latest`: `-y` suppresses
# the install prompt and `@latest` re-resolves a MUTABLE tag over the network at
# every session start — the identical supply-chain shape BUG-107 removed for
# Serena, and (offline) a hard session-start failure. It becomes a normal
# registry install of the EXACT version pinned in provision.json, done once at
# build into /usr/local/bin, so a session merely execs /usr/local/bin/playwright-mcp.
# The version is NOT written here; provision.json is the single source of truth
# and is hashed into the image tag (src/server/provisioning.ts), so a bump here
# rebuilds instead of being a silently ignored comment.
#
# NOTE — the browser is NOT baked here (a deliberate open decision: image size /
# which browser). The MCP server lists its tools with no browser; a real
# navigate needs a browser pointed at via --executable-path / --cdp-endpoint
# (src/server/tools.ts). It never auto-fetches a browser at session start.
RUN set -eux; \
    PW_PKG="$(jq -r '.tools.playwright.package' /etc/claude-station/provision.json)"; \
    PW_VER="$(jq -r '.tools.playwright.version' /etc/claude-station/provision.json)"; \
    test -n "${PW_PKG}" && test "${PW_PKG}" != "null"; \
    test -n "${PW_VER}" && test "${PW_VER}" != "null"; \
    npm install -g --prefix /usr/local "${PW_PKG}@${PW_VER}"; \
    playwright-mcp --version | grep -F "${PW_VER}"

# Non-root user pinned to the HOST uid/gid. Native bind mounts do NOT translate
# uids: without this every file the container writes into the bind-mounted repo
# is owned by a stranger on the host. ubuntu:24.04 already squats uid 1000
# (user `ubuntu`), so a naive useradd silently lands on 1001 — delete it first.
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN userdel -r ubuntu 2>/dev/null || true; \
    groupadd -g ${HOST_GID} claude 2>/dev/null || true; \
    useradd -u ${HOST_UID} -g ${HOST_GID} -m -s /bin/bash claude && \
    mkdir -p /workspace /home/claude/.claude/projects /home/claude/.local/bin && \
    ln -sf "$(command -v claude)" /home/claude/.local/bin/claude && \
    chown -R ${HOST_UID}:${HOST_GID} /workspace /home/claude

USER claude
ENV HOME=/home/claude
# Claude Station spawns the CLI via this exact path (see CONTAINER_CLAUDE_BIN).
# The ~/.local/bin copy is what the CLI expects to find itself at; running the
# npm global path directly emits a spurious "version mismatch" warning.
ENV PATH=/home/claude/.local/bin:$PATH
WORKDIR /workspace

# The container idles; every session attaches with `docker exec -i`. PID 1 is
# docker-init (HostConfig.Init = true) so orphaned execs get reaped instead of
# piling up as zombies.
CMD ["sleep", "infinity"]
