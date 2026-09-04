// policy/data.mjs — the data gate.
//
// Every event body passes through `sanitize` before it is hashed and stored.
// Secrets are never stored: a detected secret is replaced by a marker that
// records only its TYPE and LOCATION (JSON path). PII patterns (email, phone,
// IP, card, SSN) are redacted. Person names are never stored raw: plug-ins
// declare person fields, and those are replaced by keyed pseudonyms (HMAC),
// so graph analytics (co-authorship, migration) still work with no names.
import { createHmac } from 'node:crypto';

export const SECRET_PATTERNS = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g],
  ['openai-style-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['bearer-token', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ['url-credentials', /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g],
];

export const PII_PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['phone', /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\b\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b|\+\d{10,14}\b/g],
  ['ipv4', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
];

const SENSITIVE_KEY = /^(?:password|passwd|pwd|secret|secrets|token|tokens|api[_-]?key|apikey|authorization|auth|cookie|cookies|set-cookie|private[_-]?key|access[_-]?key|access[_-]?token|client[_-]?secret|refresh[_-]?token|session[_-]?id|credentials?)$/i;

function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

function redactCards(s, hits, location) {
  return s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
    hits.push({ type: 'payment-card', location });
    return '[REDACTED:payment-card]';
  });
}

/** Redact secrets and PII in a single string. Returns the cleaned string. */
export function redactString(s, hits, location) {
  let out = s;
  for (const [type, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m, g1) => {
      hits.push({ type, location });
      return type === 'url-credentials' ? `${g1}[REDACTED:url-credentials]@` : `[REDACTED:${type}]`;
    });
  }
  out = redactCards(out, hits, location); // before phone: card digit groups look like phone numbers
  for (const [type, re] of PII_PATTERNS) {
    out = out.replace(re, () => {
      hits.push({ type, location });
      return `[REDACTED:${type}]`;
    });
  }
  return out;
}

/**
 * Sanitize a JSON value. Returns { value, redactions } where redactions is a
 * list of { type, location } and never contains the redacted content.
 * `personFields` are JSON paths (e.g. "entities[].attrs.name") whose values are
 * replaced by pseudonyms via `pseudonym(str)`.
 */
export function sanitize(value, { personFields = [], pseudonym = null, maxStringLength = 20000 } = {}) {
  const hits = [];
  const personSet = new Set(personFields.map(normalizePath));
  const walk = (v, pathParts, wildcardPath) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      if (personSet.has(wildcardPath)) {
        if (!pseudonym) throw new PolicyError('person-field-without-pseudonymizer', `person field ${wildcardPath} but no pseudonymizer configured`);
        hits.push({ type: 'person', location: pathParts.join('.') });
        return pseudonym(v);
      }
      const s = v.length > maxStringLength ? v.slice(0, maxStringLength) : v;
      return redactString(s, hits, pathParts.join('.'));
    }
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...pathParts, `[${i}]`], `${wildcardPath}[]`));
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        const p = [...pathParts, k];
        const wp = wildcardPath ? `${wildcardPath}.${k}` : k;
        if (SENSITIVE_KEY.test(k) && v[k] !== null && v[k] !== undefined && typeof v[k] !== 'object') {
          hits.push({ type: `key:${k.toLowerCase()}`, location: p.join('.') });
          out[k] = '[REDACTED:sensitive-key]';
          continue;
        }
        if (personSet.has(wp) && Array.isArray(v[k])) {
          out[k] = v[k].map((x, i) => {
            if (typeof x !== 'string') return walk(x, [...p, `[${i}]`], `${wp}[]`);
            if (!pseudonym) throw new PolicyError('person-field-without-pseudonymizer', `person field ${wp}`);
            hits.push({ type: 'person', location: `${p.join('.')}[${i}]` });
            return pseudonym(x);
          });
          continue;
        }
        out[k] = walk(v[k], p, wp);
      }
      return out;
    }
    return String(v);
  };
  const cleaned = walk(value, [], '');
  return { value: cleaned, redactions: hits };
}

function normalizePath(p) {
  return p.replace(/\[\*\]/g, '[]').replace(/^\$\.?/, '');
}

/** Keyed pseudonymizer: HMAC-SHA256(salt, normalized) → 16 hex chars. */
export function makePseudonymizer(salt) {
  if (!salt || String(salt).length < 8) throw new PolicyError('salt-required', 'LOAM_PSEUDONYM_SALT must be set (>= 8 chars) before person data can be processed');
  return (s) => {
    const norm = String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return 'p_' + createHmac('sha256', String(salt)).update(norm).digest('hex').slice(0, 16);
  };
}

export class PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(`[policy:${code}] ${message}`);
    this.name = 'PolicyError';
    this.code = code;
    this.details = details;
  }
}
