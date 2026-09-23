/**
 * git-shim-secret.mjs — BUG-173 round 3. A per-HOST-PROCESS secret that
 * authenticates a git-shim `/api/git-shim/decide` caller as an Orchard-launched
 * session shim, so the decide route is not an open localhost endpoint any process
 * can drive.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * The FEAT-135 shim asks the host at call time whether a runtime grant permits a
 * classified write. Round 2 located the host purely from agent-writable env vars
 * (ORCHARD_GIT_SHIM_HOST / ORCHARD_GIT_GRANT_KEY), and the decide route trusted
 * ANY loopback caller. That let an agent (a) redirect the shim to a look-alike
 * host it stands up that always answers `{allow:true}` (self-grant, bypassing the
 * leak gate), and (b) any localhost process poke the real route. Round 3 moves
 * the host coordinates OUT of env into the generated shim's baked source, and
 * gates the route on this secret.
 *
 * The secret is minted ONCE per host process (lazily) and held ONLY in this
 * process's memory — never persisted, never on an env var the host exports. It is
 * baked into each session's generated `git` shim at launch and required back by
 * the decide route. A server restart mints a fresh one (fail-closed: a stale
 * baked secret from a previous host cannot authenticate).
 *
 * ── RESIDUAL, STATED HONESTLY ────────────────────────────────────────────────
 * A same-uid agent can READ the generated shim file (0755, in the OS temp dir)
 * and extract this secret. That does NOT let it self-grant: possessing the secret
 * only lets it call the real decide route, which still runs the SAME
 * evaluateGitWrite (peekGrant + leak gate + single-use consume) — it cannot mint
 * a grant. The redirection defence is the BAKED host URL (the shim no longer
 * reads it from env), not the secret; the secret keeps NON-session processes off
 * the route. An agent that instead REWRITES the shim file, prepends its own PATH,
 * or calls git by absolute path bypasses the shim entirely — the pre-existing
 * "determined adversarial lane" residual FEAT-135 already documents as out of
 * scope, and fundamentally unclosable between two processes of the same uid.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** The host-process credential. Null until first minted; memory-only. */
let cachedAuth = null;

/**
 * The host-process shim credential, minted lazily on first use. Called by the
 * runtime at session launch to bake into the shim, and (indirectly) by the decide
 * route's validation. One value for the life of the host process.
 */
export function getShimSecret() {
  if (cachedAuth == null) cachedAuth = randomBytes(32).toString('hex');
  return cachedAuth;
}

/**
 * TRUE only for a non-empty string EQUAL to the current host-process credential.
 * Does NOT mint: if nothing has been minted yet (no session ever launched),
 * every input is invalid → the route fails closed. The final equality is done
 * with a constant-time compare (crypto.timingSafeEqual) so the comparison is not
 * a timing side-channel; type/emptiness/mint guards run first, and a length
 * mismatch (which timingSafeEqual THROWS on) is caught by an explicit
 * length check that denies rather than throwing or falling open.
 */
export function isShimSecretValid(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || cachedAuth == null) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(cachedAuth);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** TEST-ONLY: pin or clear the credential so a verifier can assert both branches. */
export function _setShimSecretForTest(v = null) { cachedAuth = v; }
