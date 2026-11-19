/**
 * FEAT-206 — a hermetic environment for running the REAL bundled claude CLI
 * against a fake Messages API: its own HOME + CLAUDE_CONFIG_DIR under a scratch
 * dir, no inherited CLAUDE_* / ANTHROPIC_* (a parent Claude session's socket,
 * session id or account dir must never reach the child), a fake key.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function hermeticCliEnv({ scratch, apiUrl, extra = {} }) {
  const home = path.join(scratch, 'home');
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  const keep = {};
  for (const k of ['PATH', 'LANG', 'TERM', 'XDG_RUNTIME_DIR', 'TMPDIR']) if (process.env[k] !== undefined) keep[k] = process.env[k];
  return {
    ...keep,
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: apiUrl,
    ANTHROPIC_API_KEY: 'sk-ant-api03-feat206-fake-key-not-real',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    ...extra,
  };
}

/** The SDK-bundled CLI the tree at `root` resolves, and its executed --version. */
export function bundledCli(root) {
  const nm = path.join(root, 'node_modules', '@anthropic-ai');
  const bin = fs.realpathSync(path.join(nm, `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'));
  const sdkVersion = JSON.parse(fs.readFileSync(path.join(nm, 'claude-agent-sdk', 'package.json'), 'utf8')).version;
  return { bin, sdkVersion };
}
