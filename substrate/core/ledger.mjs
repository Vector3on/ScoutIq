// core/ledger.mjs — the single write path. Every event body is sanitized by
// the policy layer, hashed, clocked, and appended. Plug-ins never see this.
import { Clock, makeEvent } from './events.mjs';

export class Ledger {
  constructor({ store, node, policy, domain = null, now = () => Date.now(), onEvent = null }) {
    this.store = store;
    this.node = node;
    this.policy = policy;
    this.domain = domain;
    this.clock = new Clock(node, now);
    this.now = now;
    this.seq = 0;
    this.onEvent = onEvent; // called with each appended event (for incremental projections)
    this.emitted = 0;
    this.redactions = 0;
  }
  async init() {
    this.seq = await this.store.maxSeqForNode(this.node);
    return this;
  }
  observeClock(hlc) { this.clock.observe(hlc); }

  /**
   * Emit an event. Returns the event, or null if skipped by local dedup.
   * Sanitization is unconditional; a `policy.redacted` event records only the
   * types and locations of anything removed.
   */
  async emit(kind, body, { dedupKey = null, personFields = [], skipIfDedupKeyExists = false, domain = this.domain } = {}) {
    const { value, redactions } = this.policy.sanitize(body, { personFields });
    const ev = makeEvent({ node: this.node, seq: this.seq + 1, hlc: this.clock.tick(), kind, ts: this.now(), body: value, dedupKey, domain });
    const r = await this.store.append([ev], { origin: 'local', skipIfDedupKeyExists });
    if (r.appended === 0) {
      // Either dedup-skipped or already present: roll the clock/seq back is unsafe; seq simply stays unused.
      return null;
    }
    this.seq = ev.seq;
    this.emitted++;
    if (this.onEvent) await this.onEvent(ev);
    const real = redactions.filter((h) => h.type !== 'person');
    if (real.length) {
      this.redactions += real.length;
      await this.emit('policy.redacted', { kind, redactions: real.slice(0, 50) });
    }
    return ev;
  }
}
