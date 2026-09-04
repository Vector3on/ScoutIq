// policy/policy.mjs — composes the data, manifest, network and action gates.
import { sanitize, makePseudonymizer, PolicyError } from './data.mjs';
import { validateManifest } from './manifest.mjs';
import { NetworkGate } from './network.mjs';
import { ActionGate } from './actions.mjs';

export { PolicyError };

export class Policy {
  constructor(config = {}, deps = {}) {
    this.config = {
      userAgent: config.userAgent,
      productToken: config.productToken,
      maxRequestsPerRun: config.maxRequestsPerRun ?? 200,
      maxRequestsPerHostPerDay: config.maxRequestsPerHostPerDay ?? 1000,
      localServices: config.localServices ?? [],
      authorizedTokens: config.authorizedTokens ?? {},
      pseudonymSaltEnv: config.pseudonymSaltEnv ?? 'LOAM_PSEUDONYM_SALT',
      timeoutMs: config.timeoutMs,
    };
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => Date.now());
    this.emit = deps.emit ?? (async () => {});
    this.manifests = new Map();
    const salt = this.env[this.config.pseudonymSaltEnv];
    this._pseudonym = salt && String(salt).length >= 8 ? makePseudonymizer(salt) : null;
    this.network = new NetworkGate({
      config: this.config, manifests: this.manifests, env: this.env, now: this.now, sleep: deps.sleep,
      fetchImpl: deps.fetchImpl, emit: (k, b) => this.emit(k, b), blocks: deps.blocks, dailyCounts: deps.dailyCounts,
      robotsCache: deps.robotsCache, log: deps.log,
    });
    this.actions = new ActionGate({ emit: (k, b) => this.emit(k, b), env: this.env, now: this.now });
  }

  get hasSalt() { return !!this._pseudonym; }

  pseudonym(s) {
    if (!this._pseudonym) throw new PolicyError('salt-required', `set ${this.config.pseudonymSaltEnv} to process person data`);
    return this._pseudonym(s);
  }

  sanitize(body, { personFields = [] } = {}) {
    return sanitize(body, { personFields, pseudonym: this._pseudonym });
  }

  registerManifest(manifest) {
    const norm = validateManifest(manifest, {
      limits: { maxRequestsPerRun: this.config.maxRequestsPerRun, maxRequestsPerHostPerDay: this.config.maxRequestsPerHostPerDay },
      localServices: this.config.localServices, hasSalt: this.hasSalt,
    });
    this.manifests.set(norm.id, norm);
    return norm;
  }

  /** Install a global fetch guard so a plug-in calling fetch() directly still hits the gate. */
  installGlobalFetchGuard() {
    const gate = this.network;
    const original = globalThis.fetch;
    globalThis.fetch = (url, opts = {}) => gate.fetchGuarded(url, { method: opts.method, headers: opts.headers ?? {} });
    return () => { globalThis.fetch = original; };
  }
}
