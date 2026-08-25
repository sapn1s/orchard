/**
 * Attachable dev-tool MCP servers (FEAT-025).
 *
 * "Attach", in this codebase, means exactly one thing: an entry in the
 * `mcpServers` record handed to the runtime (RuntimeStartConfig.mcpServers,
 * forwarded verbatim to the Claude SDK's `Options.mcpServers`), plus
 * `strictMcpConfig: true` so the CLI's tool surface is EXACTLY what the station
 * handed it (no merge with the repo's `.mcp.json` or the user's global
 * `~/.claude` MCP config). The stealth browser already used this seam; Serena
 * and Playwright now plug into the same map, each gated by a per-project toggle.
 *
 * `plannedMcpServers` is the single pure function that decides the whole map. It
 * is the REAL launch/compose output — `AgentSession`'s constructor calls it and
 * forwards the result unchanged — so a verifier can assert on/off behaviour by
 * calling it directly, no live model needed (mirrors how templates.ts compose
 * functions are verified).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Project } from './registry.ts';
import { browserSettingsOf, toolSettingsOf } from './registry.ts';
import { mcpServerFor as browserMcpServerFor, MCP_SERVER_NAME, type McpStdioServer } from './browser.ts';
import { containerWorkdir } from './container-manager.ts';
import { hostSerenaBin, hostPlaywrightBin } from './provisioning.ts';

export const SERENA_SERVER_NAME = 'serena';
export const PLAYWRIGHT_SERVER_NAME = 'playwright';

/**
 * Serena's MCP server (oraios/serena), pinned to this project's checkout with
 * the `claude-code` context (which excludes the tools Claude Code already
 * provides — grep/read/etc). Keyed to the project's own checkout so it works for
 * ANY project, not only ones that happen to carry a `.mcp.json` (FEAT-025).
 *
 * BUG-035 — TWO SHAPES, exactly like `browser.ts:mcpServerFor`. An MCP server is
 * spawned by the CLI, and the CLI runs on the host for `direct` but INSIDE the
 * container for `container` (agent-bridge's `docker exec -i` spawn override).
 * `project.hostPath` does not exist in there: the repo is bind-mounted at
 * `containerWorkdir(project.id)` (`/workspace/<id>`), so a host path made Serena
 * activate a nonexistent project.
 *
 * BUG-107 — EXECUTE AN ALREADY-INSTALLED BINARY; DO NOT FETCH ONE.
 * This used to be `uvx --from git+https://github.com/oraios/serena serena …`,
 * which re-resolved a mutable git HEAD over the network on every single session
 * start — the pattern the user ruled out ("auto-fetching files yes is too much
 * supply chain risk"), and one that turns a lost network into a lost capability.
 * Both shapes now point at a durable install of the exact version pinned in
 * `container/provision.json`:
 *   container — baked into the image at build time (`/usr/local/bin/serena`);
 *   direct    — a station-managed host install under the data dir, put there by
 *               an explicit `provisionHost()`.
 * Neither resolves a version, contacts an index, or writes a cache at launch.
 *
 * WHEN THE HOST INSTALL IS ABSENT this deliberately still plans the pinned path
 * rather than falling back to a fetch. The CLI reports the server as failed and
 * BUG-035's `tooling-unavailable` card names the exact command — an honest
 * "provision me" that the user acts on once, instead of a silent download on
 * every session that nobody ever decided to accept.
 */
export const CONTAINER_SERENA_BIN = '/usr/local/bin/serena';

export function serenaMcpServerFor(project: Project): McpStdioServer {
  const inContainer = project.isolation === 'container';
  const projectDir = inContainer ? containerWorkdir(project.id) : project.hostPath;
  return {
    type: 'stdio',
    command: inContainer ? CONTAINER_SERENA_BIN : hostSerenaBin(),
    args: [
      'start-mcp-server',
      '--context', 'claude-code',
      '--project', projectDir,
      '--enable-web-dashboard', 'false',
      '--open-web-dashboard', 'false',
    ],
    env: {},
  };
}

/** The container's baked, pinned Playwright MCP entrypoint (see Dockerfile). */
export const CONTAINER_PLAYWRIGHT_BIN = '/usr/local/bin/playwright-mcp';

/** Point Playwright at an existing browser instead of fetching one. */
export const PLAYWRIGHT_CDP_ENV = 'CLAUDE_STATION_PLAYWRIGHT_CDP_ENDPOINT';
export const PLAYWRIGHT_EXECUTABLE_ENV = 'CLAUDE_STATION_PLAYWRIGHT_BROWSER';

/**
 * Resolve how a Playwright MCP session reaches a browser WITHOUT fetching one.
 *
 * `@playwright/mcp` launches a browser LAZILY (only on the first navigate), and
 * its default is the `chrome` CHANNEL — a system Google Chrome at a fixed path.
 * With no browser present it returns an actionable error ("install a browser"),
 * which is honest and, crucially, NOT an auto-fetch at session start. To make a
 * real navigate work offline we point it at a browser that already exists:
 *
 *   1. an explicit CDP endpoint  (`--cdp-endpoint`, env), or
 *   2. an explicit executable    (`--executable-path`, env), or
 *   3. for DIRECT isolation, an auto-detected host browser (brave/chrome/…)
 *      found on PATH — this repo already ships/uses brave for its own checks.
 *
 * A CONTAINER is never PATH-scanned (the host's PATH is meaningless inside it);
 * it uses the env overrides only, pointed at a browser valid in the container.
 * None of these fetches anything.
 */
export function playwrightBrowserArgs(inContainer: boolean): string[] {
  const cdp = process.env[PLAYWRIGHT_CDP_ENV];
  if (cdp && cdp.trim()) return ['--cdp-endpoint', cdp.trim()];
  const exe = process.env[PLAYWRIGHT_EXECUTABLE_ENV];
  if (exe && exe.trim()) return ['--executable-path', exe.trim()];
  if (!inContainer) {
    const found = findHostBrowserExecutable();
    if (found) return ['--executable-path', found];
  }
  return [];
}

/** First runnable browser on the host PATH (deterministic, no subprocess, no fetch). */
export function findHostBrowserExecutable(): string | null {
  const names = ['brave', 'brave-browser', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  for (const p of ['/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Playwright's MCP server (`@playwright/mcp`). Browser automation for UI-testing
 * projects — headless by default, opt-in per project.
 *
 * BUG-108 — EXECUTE AN ALREADY-INSTALLED BINARY; DO NOT FETCH ONE.
 * This used to be `npx -y @playwright/mcp@latest`: `-y` suppresses the install
 * prompt and `@latest` re-resolves a MUTABLE registry tag over the network on
 * every single session start — the identical supply-chain shape BUG-107 removed
 * for Serena, and the last remaining auto-fetch on the hot path. Both shapes now
 * point at a durable install of the exact version pinned in
 * `container/provision.json`:
 *   container — baked into the image at build time (`/usr/local/bin/playwright-mcp`);
 *   direct    — a station-managed host install under the data dir, put there by
 *               an explicit `provisionAllHost()`.
 * Neither resolves a version, contacts an index, or writes a cache at launch.
 *
 * The BROWSER is separate: it is launched lazily on first navigate, and is
 * pointed at an existing browser (see `playwrightBrowserArgs`) rather than
 * fetched — so an absent browser is an honest error, never a silent download.
 */
export function playwrightMcpServerFor(project: Project): McpStdioServer {
  const inContainer = project.isolation === 'container';
  return {
    type: 'stdio',
    command: inContainer ? CONTAINER_PLAYWRIGHT_BIN : hostPlaywrightBin(),
    args: ['--headless', ...playwrightBrowserArgs(inContainer)],
    env: {},
  };
}

export interface McpPlan {
  servers: Record<string, McpStdioServer>;
  /**
   * True when the station is providing at least one MCP server, so the CLI is
   * told this is the ONLY MCP config (no merge with .mcp.json / global config).
   * False leaves the CLI's own MCP discovery untouched (its historic behaviour
   * when nothing was attached).
   */
  strict: boolean;
}

/**
 * THE attach decision. Consults each per-project toggle and returns the exact
 * `mcpServers` map + strict flag a launched session receives. Order is stable
 * (browser, serena, playwright) but irrelevant to the SDK.
 */
export function plannedMcpServers(project: Project): McpPlan {
  const servers: Record<string, McpStdioServer> = {};
  const browserSettings = browserSettingsOf(project);
  if (browserSettings.enabled) servers[MCP_SERVER_NAME] = browserMcpServerFor(project, browserSettings.idleMs);
  const tools = toolSettingsOf(project);
  if (tools.serena) servers[SERENA_SERVER_NAME] = serenaMcpServerFor(project);
  if (tools.playwright) servers[PLAYWRIGHT_SERVER_NAME] = playwrightMcpServerFor(project);
  return { servers, strict: Object.keys(servers).length > 0 };
}
