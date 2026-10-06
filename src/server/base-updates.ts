/**
 * FEAT-157 — the server side of base-release notices: the DERIVED notice for a
 * project (rail card + agent status), and the ONE answer path the rail route, the
 * agent session route and a project's dispatch socket all use. The policy itself
 * (security floor, who may do what) is `base-releases.ts`; this file only wires
 * it to the registry and the container runtime's observed facts.
 */
import * as baseRel from './base-releases.ts';
import type * as board from './board.ts';
import * as cm from './container-manager.ts';
import * as reg from './registry.ts';
import { setBaseOpHandler } from './dispatch-broker.ts';
import * as lifecycle from './lifecycle.ts';

/**
 * The notice for a project, with the catalog entries it references, or null. Derived on every call — from ONE
 * image plan (ARCH-022: the pin, the catalog and the observed artifact read together, never separately).
 */
export function baseNoticeOf(p: reg.Project, plan: cm.ImagePlan | null = null): NonNullable<board.BoardItem['baseUpdate']> | null {
  if (p.isolation !== 'container') return null;
  let notice: baseRel.BaseNotice | null;
  let catalog: baseRel.Catalog;
  try {
    const pl = plan ?? cm.imagePlanOf(p);
    catalog = pl.catalog;
    notice = baseRel.noticeFor({
      projectId: p.id,
      imageSource: pl.source,
      pinRaw: pl.pinRaw,
      observed: pl.observed,
      lastError: cm.baseApplyErrorOf(p),
      now: new Date(),
      catalog,
    });
  } catch { return null; }
  if (!notice) return null;
  const entries = catalog.ok
    ? catalog.releases.filter((r) => notice!.versions.includes(r.version)).map((r) => ({ version: r.version, date: r.date, class: r.class, summary: r.summary, adjust: r.adjust }))
    : [];
  return { ...notice, entries };
}

export function baseRailItem(p: reg.Project): board.BoardItem | null {
  const n = baseNoticeOf(p);
  if (!n) return null;
  const title = n.state === 'catalog-error' ? 'Orchard base releases cannot be read'
    : n.state === 'recovery' ? 'Choose an Orchard base for this project'
      : n.state === 'informational' ? `Orchard base v${n.to} is available (prebuilt image: not applied)`
        : n.security ? `SECURITY — Orchard base v${n.to}`
          : n.state === 'adopted-pending' || n.state === 'apply-failed' ? `Orchard base v${n.to} adopted` : `Orchard base v${n.to} is available`;
  return { id: n.id, title, owner: '\u{1F464}', status: 'open', sev: n.security ? 'high' : '', kind: 'decision', question: n.message, options: [], baseUpdate: n };
}

/** Everything the rail card and the agent CLI need about one project's base. */
export function baseStatusOf(p: reg.Project): Record<string, unknown> {
  const plan = p.isolation === 'container' ? cm.imagePlanOf(p) : null;
  const catalog = plan?.catalog ?? baseRel.readCatalog();
  return {
    projectId: p.id,
    isolation: p.isolation,
    imageSource: plan?.source ?? null,
    pin: plan?.pinRaw ?? null,
    // ARCH-022: the SAME target a launch builds (the plan's, observation included) — never a second derivation.
    target: plan?.target ?? null,
    observed: plan?.observed ?? null,
    notice: plan ? baseNoticeOf(p, plan) : null,
    catalog: catalog.ok ? { ok: true, newest: catalog.newest.version, releases: catalog.releases } : { ok: false, error: catalog.error },
  };
}

/**
 * FEAT-157 — the ONE answer path for a base-update notice (the rail route, the
 * agent session route and the project's dispatch socket all come here). It
 * re-reads the project, requires the notice revision the answer was given
 * against, and asks `applyAction` (the policy) for the new pin. Everything from
 * the check to the write is synchronous, so two answers cannot both pass the same
 * revision.
 */
export function applyBaseUpdate(projectId: string, actor: 'user' | 'agent', body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  /*
   * ARCH-022 — an answer changes what this project's next launch builds, so it runs in the project's lifecycle
   * slot: it can never interleave with a launch that has read the old pin, and the notice it checks `rev` against
   * and the pin it writes come from the same plan.
   */
  return lifecycle.runOp(projectId, 'maintain', async () => applyBaseUpdateNow(projectId, actor, body))
    .catch((e) => ({ status: (e as { code?: string }).code === 'not-ready' ? 503 : 500, body: { error: (e as Error).message, code: (e as { code?: string }).code ?? 'error' } }));
}

function applyBaseUpdateNow(projectId: string, actor: 'user' | 'agent', body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
  const cur = reg.getProject(projectId);
  if (!cur) return { status: 404, body: { error: `project ${projectId} is not registered` } };
  if (cur.isolation !== 'container') return { status: 409, body: { error: `project ${cur.id} is not a container project; it has no Orchard base`, code: 'not-container' } };
  const action = String(body.action ?? '');
  if (!['adopt', 'defer', 'skip', 'dismiss', 'pin-dev'].includes(action)) return { status: 400, body: { error: 'action must be adopt, defer, skip, dismiss or pin-dev', code: 'bad-action' } };
  if (body.version !== undefined && !(typeof body.version === 'number' && Number.isInteger(body.version))) return { status: 400, body: { error: 'version must be an integer release number', code: 'bad-version' } };
  const plan = cm.imagePlanOf(cur);
  const notice = baseNoticeOf(cur, plan);
  if (action !== 'pin-dev') {
    if (!notice) return { status: 409, body: { error: 'there is no open base-update notice for this project (it was answered, or nothing is pending)', code: 'no-notice' } };
    if (String(body.rev ?? '') !== notice.rev) {
      return { status: 409, body: { error: 'this notice changed since it was shown (a new release, another answer, or the container moved); reload it and answer again', code: 'stale-notice', rev: notice.rev } };
    }
    if (!notice.actions.includes(action as baseRel.NoticeAction)) {
      const sec = notice.security && action === 'skip';
      return { status: 409, body: { error: sec ? `v${notice.to} is a security release; it cannot be skipped` : `"${action}" is not offered on this notice (${notice.state})`, code: sec ? 'security-not-skippable' : 'not-offered' } };
    }
    if (body.version !== undefined && action !== 'adopt' && body.version !== notice.to) {
      return { status: 409, body: { error: `this notice is about v${notice.to}, not v${body.version}`, code: 'stale-notice' } };
    }
  }
  let next: baseRel.BasePin;
  try {
    next = baseRel.applyAction({
      action: action as baseRel.ActionInput['action'],
      version: body.version === undefined ? (notice?.to ?? undefined) : (body.version as number),
      actor,
      pinRaw: plan.pinRaw,
      imageSource: plan.source,
      observed: plan.observed,
      now: new Date(),
      catalog: plan.catalog,
    });
  } catch (err) {
    if (err instanceof baseRel.BasePolicyError) return { status: err.status, body: { error: err.message, code: err.code } };
    throw err;
  }
  const updated = reg.updateProject(cur.id, { settings: { container: { base: next } } } as unknown as Partial<reg.Project>);
  cm.invalidate(cur.id);
  console.warn(`[orchard] FEAT-157 base ${action}${body.version !== undefined ? ` v${body.version}` : ''} by the ${actor} for project ${cur.id}: pin ${JSON.stringify(next)}`);
  return { status: 200, body: { ok: true, action, actor, pin: next, notice: baseNoticeOf(updated),
    ...(action === 'adopt' ? { note: 'The container moves to the adopted base at its next launch with no live session (or on Rebuild); a running session is never interrupted.' } : {}) } };
}


/**
 * A container project's agent answers ITS OWN project's notice over that project's
 * dispatch socket (a container cannot reach the host HTTP API). The socket is the
 * project; nothing in the request names one.
 */
export function registerBaseOp(): void {
  setBaseOpHandler(async (project, r) => {
    const p = reg.getProject(project.id);
    if (!p) return { status: 404, body: { error: `project ${project.id} is not registered` } };
    if (r.action === 'status') return { status: 200, body: baseStatusOf(p) };
    return await applyBaseUpdate(p.id, 'agent', { action: r.action, version: r.version, rev: r.rev });
  });
}
