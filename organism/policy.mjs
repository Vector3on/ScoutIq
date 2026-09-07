import { Policy, PolicyError } from '../substrate/policy/policy.mjs';

// The inherited four gates remain intact. This composition removes capabilities:
// no manifests, credentials, network budget, approval or execution in any host env.
export function observerPolicy(emit = async () => {}) {
  const policy = new Policy({ maxRequestsPerRun: 0, maxRequestsPerHostPerDay: 0 }, {
    env: { LOAM_AUTONOMOUS: '1' }, emit,
    fetchImpl: async () => { throw new PolicyError('offline-only', 'No network transport in the organism'); },
  });
  policy.registerManifest = () => { throw new PolicyError('offline-only', 'Import reviewed local snapshots instead'); };
  return policy;
}

export function requireObservation(kind) {
  if (!['local-symbol', 'neighbor-symbol'].includes(kind)) {
    throw new PolicyError('observation-not-declared', 'Only fixed static observations are supported');
  }
}
