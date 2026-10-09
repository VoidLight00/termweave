import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documentPaths = { features: 'tracking/features.json', acceptance: 'tracking/acceptance.json',
  upstreams: 'tracking/upstreams.json', lock: 'upstreams.lock.json', failures: 'tracking/failures.json' };

export function loadBundle(root = repositoryRoot) {
  return Object.fromEntries(Object.entries(documentPaths).map(([key, path]) => [key, JSON.parse(readFileSync(resolve(root, path), 'utf8'))]));
}

/** Implements only the JSON Schema vocabulary used by this checked-in schema. */
export function validateSchema(value, schema, root = schema, path = '$') {
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error('Only local schema references are supported');
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key], root);
    if (!target) throw new Error(`Unknown schema reference: ${schema.$ref}`);
    return validateSchema(value, target, root, path);
  }
  const vocabulary = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'type', 'additionalProperties', 'required', 'properties',
    'anyOf', 'allOf', 'const', 'enum', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'minItems', 'maxItems', 'uniqueItems', 'items']);
  for (const keyword of Object.keys(schema)) if (!vocabulary.has(keyword)) throw new Error(`Unsupported schema keyword: ${keyword}`);
  const errors = [];
  const fail = message => errors.push(`${path}: ${message}`);
  if (schema.anyOf && !schema.anyOf.some(candidate => validateSchema(value, candidate, root, path).length === 0)) fail('does not match any permitted schema');
  for (const candidate of schema.allOf ?? []) errors.push(...validateSchema(value, candidate, root, path));
  if ('const' in schema && value !== schema.const) fail(`expected constant ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`invalid enum ${JSON.stringify(value)}`);
  if (schema.type) {
    const matches = schema.type === 'null' ? value === null
      : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type;
    if (!matches) { fail(`expected ${schema.type}`); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('string too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('string too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('invalid string pattern');
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)))) fail('invalid UTC date-time');
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) fail('number below minimum');
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('duplicate array items');
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, root, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(item, schema.properties[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) fail(`unexpected property ${key}`);
    }
  }
  return errors;
}

export function safeRepositoryPath(path) {
  return typeof path === 'string' && !!path && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && !path.split('/').some(part => !part || part === '.' || part === '..') && !/^[A-Za-z]:/.test(path);
}
function localFile(root, path) {
  if (!safeRepositoryPath(path)) return false;
  const target = resolve(root, path);
  if (!existsSync(target) || !statSync(target).isFile()) return false;
  const inside = relative(realpathSync(root), realpathSync(target));
  return inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside);
}
function indexUnique(values, kind, errors) {
  const index = new Map();
  for (const value of values) {
    if (index.has(value.id)) errors.push(`${kind}: duplicate ID ${value.id}`);
    index.set(value.id, value);
  }
  return index;
}

export function validateBundle(bundle, { root = repositoryRoot, schema = JSON.parse(readFileSync(resolve(root, 'tracking/schema.json'), 'utf8')) } = {}) {
  const errors = validateSchema(bundle, schema);
  if (errors.length) return errors;
  const features = indexUnique(bundle.features.features, 'feature', errors);
  const tests = indexUnique(bundle.acceptance.tests, 'acceptance', errors);
  const upstreams = indexUnique(bundle.upstreams.upstreams, 'upstream', errors);
  const sources = indexUnique(bundle.upstreams.sources, 'source', errors);
  const issues = indexUnique(bundle.failures.issues, 'issue', errors);
  const hypotheses = indexUnique(bundle.failures.hypotheses, 'hypothesis', errors);
  const reference = (index, ids, label) => {
    for (const id of ids) if (!index.has(id)) errors.push(`${label}: unknown ID ${id}`);
  };
  const paths = (values, label) => {
    for (const path of values) if (!localFile(root, path)) errors.push(`${label}: missing or unsafe repository file ${path}`);
  };
  const evidence = (value, label) => {
    paths(value.evidence, label);
    if (value.status === 'PASS' || value.status === 'FAIL') {
      if (!value.source_revision || !value.evidence.length) errors.push(`${label}: executed result needs source revision and evidence`);
    }
    if (value.status === 'NOT_RUN' && (value.source_revision !== null || value.evidence.length)) errors.push(`${label}: NOT_RUN cannot claim executed evidence`);
  };
  for (const feature of features.values()) {
    reference(sources, feature.sources, feature.id);
    reference(features, feature.dependencies, feature.id);
    reference(tests, feature.tests, feature.id);
    paths(feature.code, feature.id);
    evidence(feature.verification, feature.id);
    if (['implemented', 'partial'].includes(feature.implementation) && !feature.code.length) errors.push(`${feature.id}: implementation needs code paths`);
    if (feature.verification.status === 'PASS' && feature.verification.source_revision !== bundle.features.source_revision) errors.push(`${feature.id}: PASS revision is stale`);
    if (feature.verification.status === 'PASS' && !['implemented', 'partial'].includes(feature.implementation)) errors.push(`${feature.id}: absent implementation cannot PASS`);
    if (feature.required_for_release && feature.verification.status === 'NOT_APPLICABLE') errors.push(`${feature.id}: required feature cannot be NOT_APPLICABLE`);
    if (feature.dependencies.includes(feature.id)) errors.push(`${feature.id}: self dependency`);
    if (feature.verification.status === 'PASS' && feature.tests.some(id => tests.get(id)?.coverage !== 'existing')) errors.push(`${feature.id}: acceptance gaps remain`);
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) { errors.push(`feature: dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of features.get(id)?.dependencies ?? []) if (features.has(next)) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of features.keys()) visit(id);
  for (const test of tests.values()) {
    paths(test.files, test.id);
    if (test.coverage !== 'planned' && !test.files.length) errors.push(`${test.id}: existing or partial coverage needs test files`);
    if (test.coverage === 'partial' && !test.gap) errors.push(`${test.id}: partial coverage needs a gap description`);
    if (![...features.values()].some(feature => feature.tests.includes(test.id))) errors.push(`${test.id}: orphan acceptance test`);
  }
  if ([...upstreams.keys()].sort().join(',') !== 'cmux,herdr,herdr-web-ui') errors.push('upstream: expected three approved repository IDs');
  const repositories = { 'herdr-web-ui': 'devswha/herdr-web-ui', herdr: 'herdrdev/herdr', cmux: 'manaflow-ai/cmux' };
  for (const upstream of upstreams.values()) {
    if (upstream.repository !== repositories[upstream.id]) errors.push(`${upstream.id}: unexpected repository`);
    if (upstream.observed.status === 'OBSERVED' && !upstream.observed.revision) errors.push(`${upstream.id}: observation needs revision`);
    if (upstream.observed.status === 'UNKNOWN' && upstream.observed.revision !== null) errors.push(`${upstream.id}: UNKNOWN observation cannot claim revision`);
    if (upstream.license.status === 'VERIFIED_DOCUMENT' && (!upstream.license.revision || !upstream.license.sha256)) errors.push(`${upstream.id}: verified license needs revision and hash`);
    if (!upstream.discovery.signals.includes('unmapped-source-path') || !upstream.discovery.signals.includes('readme-feature-change')) errors.push(`${upstream.id}: new feature discovery signals missing`);
    if (upstream.id === 'cmux' && upstream.license.copy_policy !== 'reference-only-no-code-or-assets') errors.push('cmux: code and assets must remain excluded');
    for (const path of upstream.watch_paths) if (!safeRepositoryPath(path.endsWith('/') ? path.slice(0, -1) : path)) errors.push(`${upstream.id}: unsafe watch path`);
  }
  for (const source of sources.values()) {
    if (source.upstream !== null && !upstreams.has(source.upstream)) errors.push(`${source.id}: unknown upstream`);
    if (source.usage === 'behavior-reference-only') {
      const upstream = upstreams.get(source.upstream);
      const prefix = upstream && `https://github.com/${upstream.repository}/blob/${source.revision}/`;
      if (!prefix || !source.url?.startsWith(prefix) || !source.sha256) errors.push(`${source.id}: remote reference needs pinned URL and content hash`);
      if (source.lines && source.lines[0] > source.lines[1]) errors.push(`${source.id}: reversed source lines`);
    } else paths([source.path], source.id);
    if (source.upstream === 'cmux' && source.usage !== 'behavior-reference-only') errors.push(`${source.id}: cmux source import is forbidden`);
  }
  const locks = new Map();
  for (const entry of bundle.lock.entries) {
    if (locks.has(entry.upstream)) errors.push(`lock: duplicate upstream ${entry.upstream}`);
    locks.set(entry.upstream, entry);
    const upstream = upstreams.get(entry.upstream);
    if (!upstream || entry.repository !== upstream.repository) errors.push(`lock: repository mismatch ${entry.upstream}`);
    paths(entry.evidence, `lock ${entry.upstream}`);
    if (entry.compatibility === 'PASS' && (entry.approval !== 'COMPATIBILITY_APPROVED' || !entry.revision || !entry.evidence.length)) errors.push(`lock ${entry.upstream}: compatibility needs separate approval, revision and evidence`);
    if (entry.approval === 'SOURCE_BASELINE_ONLY' && (entry.use !== 'curated-source-baseline' || !entry.revision || entry.compatibility !== 'UNKNOWN')) errors.push(`lock ${entry.upstream}: source baseline is not compatibility approval`);
    if (entry.approval === 'PENDING_RUNTIME_VERIFICATION' && (entry.revision !== null || entry.compatibility !== 'UNKNOWN')) errors.push(`lock ${entry.upstream}: unverified runtime cannot adopt observed revision`);
    if (entry.upstream === 'cmux' && (entry.approval !== 'NO_CODE_IMPORT' || entry.use !== 'behavior-reference-only' || entry.compatibility !== 'NOT_APPLICABLE' || entry.revision !== null)) errors.push('lock cmux: reference-only boundary violated');
  }
  if (locks.size !== upstreams.size) errors.push('lock: each tracked upstream needs one entry');
  if (bundle.lock.compatibility_status === 'PASS' && [...locks.values()].some(entry => !['PASS', 'NOT_APPLICABLE'].includes(entry.compatibility))) errors.push('lock: aggregate compatibility PASS is unsupported');
  const provenance = JSON.parse(readFileSync(resolve(root, 'docs/source-provenance.json'), 'utf8'));
  if (locks.get('herdr-web-ui')?.approval === 'SOURCE_BASELINE_ONLY' && locks.get('herdr-web-ui')?.revision !== provenance.upstream_base_sha) errors.push('lock: source baseline differs from preserved provenance');
  for (const issue of issues.values()) {
    reference(features, issue.features, issue.id); reference(tests, issue.acceptance, issue.id); reference(hypotheses, issue.hypotheses, issue.id);
    if (issue.status === 'CONFIRMED_DISABLED' && issue.release_blocker) errors.push(`${issue.id}: disabled workflow is not a live release blocker`);
    for (const id of issue.review_ids) if (!/^PUB-00[1-9]$|^PUB-010$/.test(id)) errors.push(`${issue.id}: invalid publication review ID`);
  }
  for (const hypothesis of hypotheses.values()) paths(hypothesis.code, hypothesis.id);
  if (bundle.failures.release_status === 'READY_FOR_REVIEW' && issues.size && [...issues.values()].some(issue => issue.release_blocker && issue.status !== 'RESOLVED')) errors.push('release: unresolved blockers prevent READY_FOR_REVIEW');
  return errors;
}

export function releaseReadiness(bundle) {
  const reasons = [];
  for (const feature of bundle.features.features) if (feature.required_for_release && feature.verification.status !== 'PASS') reasons.push(`${feature.id}: ${feature.verification.status}`);
  for (const issue of bundle.failures.issues) if (issue.release_blocker && issue.status !== 'RESOLVED') reasons.push(`${issue.id}: ${issue.status}`);
  if (bundle.lock.compatibility_status !== 'PASS') reasons.push('compatibility: UNKNOWN');
  return { status: reasons.length ? 'BLOCKED' : 'READY_FOR_REVIEW', reasons };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const bundle = loadBundle();
    const errors = validateBundle(bundle);
    if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 1; }
    else {
      console.log(`PASS[ledger-structure] features=${bundle.features.features.length} acceptance=${bundle.acceptance.tests.length} upstreams=${bundle.upstreams.upstreams.length}`);
      const readiness = releaseReadiness(bundle);
      console.log(`${readiness.status}[release-readiness] reasons=${readiness.reasons.length}`);
      console.log('P2 validates ledger structure and links only. Product runtime checks were not run.');
      if (process.argv.includes('--release-ready') && readiness.status !== 'READY_FOR_REVIEW') {
        readiness.reasons.forEach(reason => console.error(reason)); process.exitCode = 2;
      }
    }
  } catch (error) { console.error(`FAIL[ledger-load] ${error.message}`); process.exitCode = 1; }
}
