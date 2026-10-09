import { expect, it } from "bun:test";
import type { OutputBundle } from "rollup";
import { frontendBuildIdentity } from "./frontend-build-identity.ts";
function identity(code: string): string {
  const bundle = { 'index.html': { type: 'asset', source: '<html><head></head></html>' },
    'assets/app.js': { type: 'chunk', code } } as unknown as OutputBundle;
  const plugin = frontendBuildIdentity();
  const hook = plugin.generateBundle;
  if (typeof hook !== 'function') throw new Error('Expected identity generation hook');
  hook.call({} as never, {} as never, bundle, false);
  return String((bundle['index.html'] as { source: string }).source);
}
it('same emitted artifacts yield the same identity; changed frontend yields a new identity without a package version bump', () => {
  expect(identity('old')).toBe(identity('old'));
  expect(identity('old')).not.toBe(identity('new'));
  expect(identity('new')).toMatch(/frontend-build-id" content="[a-f0-9]{64}"/);
});
