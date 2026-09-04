// policy/actions.mjs — the action gate.
//
// The autonomous loop observes and reasons; it never acts on outside systems.
// Any consequential action a plug-in wants is a PROPOSAL: an event a human can
// approve or reject with the CLI. Execution is a separate, human-invoked path
// that refuses to run in any autonomous context (CI, cron, LOAM_AUTONOMOUS).
import { shortHash } from '../core/events.mjs';
import { PolicyError } from './data.mjs';

export function isAutonomousEnv(env = process.env) {
  return !!(env.GITHUB_ACTIONS || env.CI || env.LOAM_AUTONOMOUS || env.COLAB_RELEASE_TAG);
}

export class ActionGate {
  constructor({ emit = async () => {}, env = process.env, now = () => Date.now() } = {}) {
    this.emit = emit;
    this.env = env;
    this.now = now;
    this.proposedThisRun = [];
  }

  /** Record a proposal. Always allowed; never executes anything. */
  async propose({ kind, target, rationale, payload = {}, domain = null, sensor = null }) {
    if (!kind || !target || !rationale) throw new PolicyError('proposal-incomplete', 'kind, target and rationale are required');
    const id = shortHash({ kind, target, payload, t: this.now() }).slice(0, 16);
    const body = { proposalId: id, kind, target, rationale, payload, domain, sensor, status: 'pending', createdAt: this.now() };
    this.proposedThisRun.push(body);
    await this.emit('proposal.created', body);
    return id;
  }

  async approve(id, { by = 'operator', note = '' } = {}) {
    if (isAutonomousEnv(this.env)) throw new PolicyError('approval-in-autonomous-context', 'proposals can only be approved by a human outside CI/cron');
    await this.emit('proposal.approved', { proposalId: id, by, note, at: this.now() });
  }

  async reject(id, { by = 'operator', note = '' } = {}) {
    await this.emit('proposal.rejected', { proposalId: id, by, note, at: this.now() });
  }

  /**
   * Execute an approved proposal via `executor(proposal, ctx)`. Refuses in any
   * autonomous context and unless the projected status is 'approved'.
   */
  async executeApproved(id, executor, { proposals, confirm = false } = {}) {
    if (isAutonomousEnv(this.env)) throw new PolicyError('execution-in-autonomous-context', 'the autonomous loop never executes proposals');
    if (!confirm) throw new PolicyError('execution-not-confirmed', 'pass confirm: true (CLI --confirm) to execute an approved proposal');
    const p = proposals?.get?.(id);
    if (!p) throw new PolicyError('proposal-unknown', `no proposal ${id}`);
    if (p.status !== 'approved') throw new PolicyError('proposal-not-approved', `proposal ${id} is ${p.status}`);
    const result = await executor(p);
    await this.emit('proposal.executed', { proposalId: id, at: this.now(), result: typeof result === 'string' ? result.slice(0, 500) : (result ?? null) });
    return result;
  }
}

/** Projection helper: fold proposal events into a Map(id → proposal). */
export function applyProposalEvent(proposals, ev) {
  const b = ev.body;
  if (ev.kind === 'proposal.created') {
    if (!proposals.has(b.proposalId)) proposals.set(b.proposalId, { ...b, history: [] });
  } else if (ev.kind === 'proposal.approved' || ev.kind === 'proposal.rejected' || ev.kind === 'proposal.executed') {
    const p = proposals.get(b.proposalId);
    if (!p) return;
    const status = ev.kind === 'proposal.approved' ? 'approved' : ev.kind === 'proposal.rejected' ? 'rejected' : 'executed';
    // executed can only follow approved; rejected is terminal.
    if (p.status === 'rejected' || p.status === 'executed') return;
    if (status === 'executed' && p.status !== 'approved') return;
    p.status = status;
    p.history.push({ status, by: b.by ?? null, note: b.note ?? null, at: b.at });
  }
}
