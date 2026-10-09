import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadBundle, repositoryRoot, releaseReadiness, safeRepositoryPath, validateBundle, validateSchema } from './validate-ledgers.mjs';

const current = loadBundle();
const schema = JSON.parse(readFileSync(resolve(repositoryRoot, 'tracking/schema.json'), 'utf8'));
const copy = () => structuredClone(current);
const rejected = (mutate, match) => {
  const bundle = copy(); mutate(bundle);
  assert.ok(validateBundle(bundle).some(error => match.test(error)), `Expected validation failure: ${match}`);
};

test('checked-in ledgers have valid schemas and code/test/source links', () => {
  assert.deepEqual(validateBundle(current), []);
  assert.equal(current.features.features.length, 28);
  assert.equal(current.acceptance.tests.length, 36);
});
test('implementation inventory does not claim current runtime execution', () => {
  assert.ok(current.features.features.every(feature => ['NOT_RUN', 'NOT_APPLICABLE'].includes(feature.verification.status)));
  assert.equal(releaseReadiness(current).status, 'BLOCKED');
  assert.equal(current.failures.release_status, 'BLOCKED');
});
test('all custom implementation files have feature mappings', () => {
  const paths = current.features.features.filter(feature => feature.origin === 'custom').flatMap(feature => feature.code);
  for (const path of ['src/lib/dockLayout.ts', 'src/lib/dockDrag.ts', 'src/lib/sessionLayout.ts', 'src/lib/spatialFocus.ts',
    'src/components/DockGroup.tsx', 'src/components/DockDivider.tsx', 'src/components/SplitTerminals.tsx',
    'src/components/NativePaneMove.tsx', 'src/components/TerminalSearch.tsx', 'src/components/BrowserPanel.tsx',
    'server/pane-split.ts', 'server/pane-move.ts', 'shared/paneMove.ts', 'src/App.tsx']) assert.ok(paths.includes(path), path);
});
test('both clipping symptoms retain unconfirmed hypotheses and acceptance gaps', () => {
  for (const id of ['RENDER-SLIDER-001', 'RENDER-SINGLE-001']) {
    const issue = current.failures.issues.find(issue => issue.id === id);
    assert.equal(issue.status, 'UNCONFIRMED'); assert.equal(issue.release_blocker, true);
    assert.deepEqual(issue.hypotheses, ['H-FLEX-SHRINK', 'H-FIT-DELAY', 'H-SHARED-GEOMETRY']);
  }
  assert.ok(current.failures.hypotheses.every(item => item.status === 'UNCONFIRMED'));
});
test('publication review IDs are traceable and disabled workflows stay distinct', () => {
  const ids = new Set(current.failures.issues.flatMap(issue => issue.review_ids));
  for (let index = 1; index <= 10; index++) assert.ok(ids.has(`PUB-${String(index).padStart(3, '0')}`));
  const disabled = current.failures.issues.find(issue => issue.review_ids.includes('PUB-010'));
  assert.equal(disabled.status, 'CONFIRMED_DISABLED'); assert.equal(disabled.release_blocker, false);
});
test('observed revisions do not silently become approved compatibility locks', () => {
  assert.notEqual(current.upstreams.upstreams.find(item => item.id === 'herdr-web-ui').observed.revision,
    current.lock.entries.find(item => item.upstream === 'herdr-web-ui').revision);
  assert.equal(current.lock.entries.find(item => item.upstream === 'herdr').revision, null);
  assert.equal(current.lock.entries.find(item => item.upstream === 'cmux').revision, null);
  rejected(bundle => { bundle.lock.entries[1].revision = bundle.upstreams.upstreams[1].observed.revision; }, /unverified runtime/);
});
test('schema rejects unknown fields, invalid enums, types and revisions', () => {
  rejected(bundle => { bundle.features.features[0].surprise = 'field'; }, /unexpected property/);
  rejected(bundle => { bundle.features.features[0].verification.status = 'SUCCESS'; }, /invalid enum/);
  rejected(bundle => { bundle.features.features[0].required_for_release = 'true'; }, /expected boolean/);
  rejected(bundle => { bundle.features.source_revision = 'latest'; }, /invalid string pattern/);
  assert.ok(validateSchema({ features: [] }, schema).length > 0);
  assert.throws(() => validateSchema('data', { type: 'string', unknownKeyword: true }), /Unsupported schema keyword/);
});
test('duplicate IDs and unconnected references fail', () => {
  rejected(bundle => { bundle.features.features.push(structuredClone(bundle.features.features[0])); }, /duplicate ID/);
  rejected(bundle => { bundle.features.features[0].tests = ['AC-MISSING']; }, /unknown ID/);
  rejected(bundle => { bundle.features.features[0].sources = ['missing-source']; }, /unknown ID/);
  rejected(bundle => { bundle.features.features[0].dependencies = ['MISSING-001']; }, /unknown ID/);
});
test('dependency cycles fail', () => {
  rejected(bundle => { bundle.features.features[0].dependencies = ['WORKSPACE-STORE-001']; }, /dependency cycle/);
});
test('missing and escaping code/test/evidence paths fail', () => {
  rejected(bundle => { bundle.features.features[0].code = ['src/absent.ts']; }, /missing or unsafe/);
  rejected(bundle => { bundle.acceptance.tests[0].files = ['../outside.test.ts']; }, /missing or unsafe/);
  for (const path of ['/tmp/file', '../file', 'src/../file', 'C:\\file', 'src\\file', 'src//file', './file']) assert.equal(safeRepositoryPath(path), false, path);
  assert.equal(safeRepositoryPath('src/lib/dockLayout.ts'), true);
});
test('PASS needs executed source and evidence and cannot use stale revisions', () => {
  rejected(bundle => { bundle.features.features[0].verification.status = 'PASS'; }, /executed result needs/);
  rejected(bundle => { bundle.features.features[0].verification = { status: 'PASS', source_revision: 'a'.repeat(40), evidence: ['docs/P0-P1.md'] }; }, /PASS revision is stale/);
  rejected(bundle => { bundle.features.features[0].verification.evidence = ['docs/P0-P1.md']; }, /NOT_RUN cannot claim/);
  rejected(bundle => { bundle.features.features[2].verification = { status: 'PASS', source_revision: bundle.features.source_revision, evidence: ['docs/P0-P1.md'] }; }, /acceptance gaps remain/);
});
test('required checks and incomplete acceptance cannot be hidden', () => {
  rejected(bundle => { bundle.features.features[0].verification.status = 'NOT_APPLICABLE'; }, /required feature/);
  rejected(bundle => { bundle.acceptance.tests[0].files = []; }, /needs test files/);
  rejected(bundle => { delete bundle.acceptance.tests.find(item => item.coverage === 'partial').gap; }, /gap description/);
});
test('cmux remains reference only and remote references must be revision pinned', () => {
  rejected(bundle => { bundle.upstreams.upstreams[2].license.copy_policy = 'retain-notices-review-changes'; }, /cmux/);
  rejected(bundle => { bundle.upstreams.sources.find(item => item.upstream === 'cmux').usage = 'curated-source-snapshot'; }, /cmux source import/);
  rejected(bundle => { bundle.upstreams.sources.find(item => item.usage === 'behavior-reference-only').url = 'https://github.com/example/project/blob/main/README.md'; }, /pinned URL/);
});
test('unknown observations and discovery omissions fail closed', () => {
  rejected(bundle => { bundle.upstreams.upstreams[0].observed.status = 'UNKNOWN'; }, /UNKNOWN observation/);
  rejected(bundle => { bundle.upstreams.upstreams[0].discovery.signals = ['release']; }, /discovery signals/);
});
test('aggregate compatibility and publication cannot override blockers', () => {
  rejected(bundle => { bundle.lock.compatibility_status = 'PASS'; }, /unsupported/);
  rejected(bundle => { bundle.failures.release_status = 'READY_FOR_REVIEW'; }, /unresolved blockers/);
  rejected(bundle => { bundle.failures.issues.find(issue => issue.status === 'CONFIRMED_DISABLED').release_blocker = true; }, /disabled workflow/);
});
test('source baseline agrees with curated provenance, not observed upstream HEAD', () => {
  rejected(bundle => { bundle.lock.entries[0].revision = bundle.upstreams.upstreams[0].observed.revision; }, /differs from preserved provenance/);
});
