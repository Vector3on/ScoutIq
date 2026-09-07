// policy/manifest.mjs — strict plug-in manifest validation.
//
// A manifest declares exactly which hosts, paths, methods, rates and data
// classes a sensor needs. Anything undeclared is denied at runtime, and any
// unknown key (e.g. `bypassRobots`, `cookies`, `scrape`) refuses the plug-in
// at load time — the schema is the refusal.
import { PolicyError } from './data.mjs';

export const DATA_CLASSES = ['public-metadata', 'text', 'person', 'local-synthetic'];
export const METHODS = ['GET', 'HEAD', 'POST'];
const TOP_KEYS = new Set(['id', 'version', 'description', 'terms', 'endpoints', 'auth', 'tokenEnv', 'dataClasses', 'personFields', 'scale', 'userAgentContact']);
const TERMS_KEYS = new Set(['url', 'officialApi', 'notes']);
const ENDPOINT_KEYS = new Set(['host', 'pathPrefix', 'methods', 'minIntervalMs', 'dailyCap', 'readOnly', 'maxBytes']);
const SCALE_KEYS = new Set(['maxRequestsPerRun']);
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function rejectUnknown(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new PolicyError('manifest-unknown-key', `${where}: unknown key "${k}" (undeclared capabilities are refused)`);
  }
}

/**
 * Validate and normalize a manifest. Returns the normalized manifest.
 * `limits` are the policy-wide caps a manifest may not exceed.
 */
export function validateManifest(m, { limits = {}, localServices = [], hasSalt = false } = {}) {
  if (!m || typeof m !== 'object') throw new PolicyError('manifest-missing', 'manifest required');
  rejectUnknown(m, TOP_KEYS, 'manifest');
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id)) throw new PolicyError('manifest-id', 'id must match /^[a-z0-9][a-z0-9-]{1,40}$/');
  if (typeof m.version !== 'string') throw new PolicyError('manifest-version', `${m.id}: version string required`);
  if (typeof m.description !== 'string' || !m.description) throw new PolicyError('manifest-description', `${m.id}: description required`);
  if (!Array.isArray(m.dataClasses) || !m.dataClasses.length) throw new PolicyError('manifest-data-classes', `${m.id}: dataClasses required`);
  for (const c of m.dataClasses) if (!DATA_CLASSES.includes(c)) throw new PolicyError('manifest-data-classes', `${m.id}: unknown data class ${c}`);
  if (m.dataClasses.includes('person') && !hasSalt) throw new PolicyError('salt-required', `${m.id} processes person data but no pseudonym salt is configured (set LOAM_PSEUDONYM_SALT)`);
  const personFields = m.personFields ?? [];
  if (!Array.isArray(personFields) || personFields.some((p) => typeof p !== 'string')) throw new PolicyError('manifest-person-fields', `${m.id}: personFields must be strings`);
  if (personFields.length && !m.dataClasses.includes('person')) throw new PolicyError('manifest-person-fields', `${m.id}: personFields declared without the person data class`);

  const endpoints = m.endpoints ?? [];
  if (!Array.isArray(endpoints)) throw new PolicyError('manifest-endpoints', `${m.id}: endpoints must be an array`);
  const maxDaily = limits.maxRequestsPerHostPerDay ?? 5000;
  const normEndpoints = endpoints.map((e, i) => {
    const where = `${m.id}.endpoints[${i}]`;
    rejectUnknown(e, ENDPOINT_KEYS, where);
    const host = String(e.host ?? '').toLowerCase();
    const isLocal = localServices.includes(host);
    if (!isLocal && !HOST_RE.test(host)) throw new PolicyError('manifest-host', `${where}: host must be a fully-qualified public hostname (no IPs, wildcards, or localhost): "${host}"`);
    if (typeof e.pathPrefix !== 'string' || !e.pathPrefix.startsWith('/')) throw new PolicyError('manifest-path', `${where}: pathPrefix must start with /`);
    const methods = (e.methods ?? ['GET']).map((x) => String(x).toUpperCase());
    for (const mm of methods) if (!METHODS.includes(mm)) throw new PolicyError('manifest-method', `${where}: method ${mm} not permitted`);
    if (methods.includes('POST') && e.readOnly !== true) throw new PolicyError('manifest-method', `${where}: POST endpoints must be declared readOnly: true (query-style read APIs only)`);
    const minIntervalMs = e.minIntervalMs ?? 1000;
    if (!Number.isInteger(minIntervalMs) || minIntervalMs < 100) throw new PolicyError('manifest-rate', `${where}: minIntervalMs must be an integer >= 100`);
    const dailyCap = e.dailyCap ?? 500;
    if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > maxDaily) throw new PolicyError('manifest-rate', `${where}: dailyCap must be 1..${maxDaily}`);
    const maxBytes = e.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024) throw new PolicyError('manifest-bytes', `${where}: maxBytes out of range`);
    return { host, pathPrefix: e.pathPrefix, methods, minIntervalMs, dailyCap, readOnly: !!e.readOnly, maxBytes, local: isLocal };
  });

  const auth = m.auth ?? 'none';
  if (!['none', 'token-optional', 'token-required'].includes(auth)) throw new PolicyError('manifest-auth', `${m.id}: auth must be none | token-optional | token-required`);
  if (auth !== 'none') {
    if (typeof m.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,40}$/.test(m.tokenEnv)) throw new PolicyError('manifest-auth', `${m.id}: auth requires tokenEnv (an environment variable NAME, never a value)`);
    if (m.terms?.officialApi !== true) throw new PolicyError('manifest-auth', `${m.id}: authenticated access is only permitted against an official API (terms.officialApi: true); authenticated scraping is refused`);
  }
  if (m.tokenEnv && auth === 'none') throw new PolicyError('manifest-auth', `${m.id}: tokenEnv without auth mode`);

  if (normEndpoints.length) {
    if (!m.terms || typeof m.terms !== 'object') throw new PolicyError('manifest-terms', `${m.id}: terms { url, officialApi } required for network sensors`);
    rejectUnknown(m.terms, TERMS_KEYS, `${m.id}.terms`);
    if (typeof m.terms.url !== 'string' || !/^https:\/\//.test(m.terms.url)) throw new PolicyError('manifest-terms', `${m.id}: terms.url must be an https URL`);
    if (typeof m.terms.officialApi !== 'boolean') throw new PolicyError('manifest-terms', `${m.id}: terms.officialApi must be boolean`);
  }
  const scale = m.scale ?? {};
  rejectUnknown(scale, SCALE_KEYS, `${m.id}.scale`);
  const maxPerRun = scale.maxRequestsPerRun ?? 50;
  const cap = limits.maxRequestsPerRun ?? 500;
  if (!Number.isInteger(maxPerRun) || maxPerRun < 0 || maxPerRun > cap) throw new PolicyError('manifest-scale', `${m.id}: scale.maxRequestsPerRun must be 0..${cap}`);

  return Object.freeze({
    id: m.id, version: m.version, description: m.description,
    terms: m.terms ? { url: m.terms.url, officialApi: !!m.terms.officialApi, notes: m.terms.notes ?? '' } : null,
    endpoints: Object.freeze(normEndpoints), auth, tokenEnv: m.tokenEnv ?? null,
    dataClasses: Object.freeze([...m.dataClasses]), personFields: Object.freeze([...personFields]),
    scale: { maxRequestsPerRun: maxPerRun }, userAgentContact: m.userAgentContact ?? null,
  });
}
