// plugins/bounty/fingerprint.mjs — infer a target's anatomy from PUBLIC signals only.
//
// Input: one in-scope asset from a public program/scope feed (arkadiyt/bounty-
// targets-data schema) plus its program. Output: the anatomy class(es) the asset
// most plausibly instantiates, and coarse fingerprint tags (the same vocabulary
// the technique catalog uses for preconditions).
//
// This is INFERENCE, NEVER PROOF (atlas index, "Scope and limits"). We read the
// asset type, host shape, and program text — all already published in the feed.
// We never connect to, probe, scan, or fetch the target itself. Absence proves
// nothing; a class here is "this architecture is plausible", not "this exists".
import { classifyFindable } from '../../../scripts/ev-core.mjs';

const FP = {
  http: /https?:\/\/|\bapi\.|\bwww\.|\bhttp\b/i,
  'oauth-oidc-saml': /oauth|oidc|saml|\bsso\b|openid|login|account|identity|auth/i,
  'jwt-session': /token|session|cookie|\bjwt\b/i,
  'cloud-iam': /cloud|\baws\b|azure|\bgcp\b|\biam\b|tenant|\bs3\b|bucket|metadata/i,
  'ci-cd': /github|gitlab|jenkins|pipeline|\bci\b|actions|build|artifact/i,
  'containers-k8s': /kubernetes|\bk8s\b|container|docker|helm|openshift/i,
  'ai-agent-mcp': /\bai\b|\bml\b|\bllm\b|agent|\bgpt\b|copilot|assistant|\bmcp\b|prompt|chatbot/i,
  'browser-ext': /extension|chrome-?ext|webstore|addon/i,
  'supply-chain-pkg': /\bnpm\b|\bpypi\b|maven|package|registry|dependency/i,
  'smart-contract-evm': /0x[a-f0-9]{6,}|solidity|\bevm\b|contract|defi|vault|\bamm\b|token|erc-?\d+/i,
  'blockchain-consensus': /chain|consensus|validator|sequencer|rollup|bridge|\bl1\b|\bl2\b|staking/i,
  'dns-tls-pki': /\bdns\b|\btls\b|\bpki\b|certificate|registrar|resolver/i,
  'database-storage': /database|\bsql\b|postgres|mysql|mongo|\bs3\b|storage/i,
  'document-media': /\bpdf\b|\bpng\b|image|media|upload|document|font/i,
  'messaging-queue': /queue|kafka|rabbit|webhook|event|stream|notification/i,
  'email': /email|smtp|\bmail\b|imap|dmarc|dkim/i,
  'hardware-radio': /hardware|firmware|device|\biot\b|baseband|cellular|\bota\b/i,
  'kernel-os': /kernel|driver|desktop|\bexe\b|binary|executable|windows|linux|macos/i,
  cache: /\bcdn\b|cache|edge|cloudflare|fastly|akamai/i,
};

// bounty-targets-data asset_type → primary anatomy class(es).
const TYPE_CLASSES = {
  URL: ['web'], WILDCARD: ['web'], API: ['api', 'web'], IP_ADDRESS: ['network', 'os'],
  CIDR: ['network', 'os'], SMART_CONTRACT: ['defi'], SOURCE_CODE: ['cicd'],
  APPLE_STORE_APP_ID: ['mobile'], GOOGLE_PLAY_APP_ID: ['mobile'], OTHER_APK: ['mobile'],
  TESTFLIGHT: ['mobile'], WINDOWS_APP_STORE_APP_ID: ['os'], DOWNLOADABLE_EXECUTABLES: ['os', 'documents'],
  HARDWARE: ['iot'], OTHER: ['web'],
};

// keyword → extra anatomy class (layered on top of the type mapping; classes compose).
const KEYWORD_CLASSES = [
  [/oauth|oidc|saml|\bsso\b|login|identity|account|openid/i, 'identity'],
  [/cloud|\baws\b|azure|\bgcp\b|\biam\b|tenant|metadata/i, 'cloud'],
  [/kubernetes|\bk8s\b|container|docker|helm/i, 'containers'],
  [/\bai\b|\bllm\b|agent|\bgpt\b|copilot|\bmcp\b|prompt|chatbot|assistant/i, 'agents'],
  [/email|smtp|\bmail\b|imap|dmarc/i, 'email'],
  [/\bdns\b|\btls\b|\bpki\b|certificate|registrar/i, 'network'],
  [/database|\bsql\b|postgres|mysql|mongo/i, 'storage'],
  [/queue|kafka|rabbit|webhook|event stream/i, 'messaging'],
  [/extension|chrome-?ext|webstore/i, 'browser'],
  [/\bpdf\b|\bpng\b|image proxy|document|upload|media|font/i, 'documents'],
  [/\biot\b|firmware|device|baseband|cellular/i, 'iot'],
  [/rollup|bridge|sequencer|\bl2\b/i, 'l2'],
  [/consensus|validator|staking|\bl1\b/i, 'l1'],
  [/graphql|\bapi\b|\bgrpc\b/i, 'api'],
];

/** Infer anatomy classes + fingerprints for one asset. Public inference only. */
export function fingerprintAsset(asset, program) {
  // tolerate both the raw feed shape (asset_type/asset_identifier) and the
  // normalised shape (type/identifier).
  const type = String(asset.type ?? asset.asset_type ?? 'OTHER').toUpperCase();
  const idText = String(asset.identifier ?? asset.asset_identifier ?? '');
  // class inference may use program context (name/website); fingerprints describe
  // the ASSET only (id + instruction) so a program's https:// website does not
  // bleed an http fingerprint onto a smart contract or a mobile app.
  const classText = `${program.name ?? ''} ${program.website ?? ''} ${idText} ${asset.instruction ?? ''}`.toLowerCase();
  const fpText = `${idText} ${asset.instruction ?? ''}`.toLowerCase();

  const classes = new Set(TYPE_CLASSES[type] ?? ['web']);
  // api. host hint on a URL
  if ((type === 'URL' || type === 'WILDCARD') && /(^|\/\/|\.)api[.-]/i.test(idText)) classes.add('api');
  for (const [re, cls] of KEYWORD_CLASSES) if (re.test(classText)) classes.add(cls);

  const fingerprints = Object.keys(FP).filter((f) => FP[f].test(fpText));
  // asset-type guaranteed fingerprints (so a bare host still fits the http family, etc.)
  if (type === 'URL' || type === 'WILDCARD' || type === 'API' || type === 'OTHER') fingerprints.push('http');
  if (type === 'SMART_CONTRACT') fingerprints.push('smart-contract-evm');
  if (type === 'SOURCE_CODE') { fingerprints.push('ci-cd'); fingerprints.push('supply-chain-pkg'); }
  if (type.includes('APP') || type === 'TESTFLIGHT' || type === 'OTHER_APK') fingerprints.push('hardware-radio');

  // ScoutIq's own findability classifier is a second, independent opinion on the
  // dominant surface; fold its workflow into a class hint so the two agree or diverge visibly.
  let evClass = null;
  try {
    const c = classifyFindable(program, { type: asset.type ?? asset.asset_type, value: idText }, null, null);
    evClass = c.className;
    if (c.workflow === 'ai-agent') classes.add('agents');
    if (c.workflow === 'live-contract') classes.add('defi');
    if (c.workflow === 'live-api') classes.add('api');
  } catch { /* classifier is best-effort */ }

  return { classes: [...classes], fingerprints: [...new Set(fingerprints)], assetType: type, evClass };
}
