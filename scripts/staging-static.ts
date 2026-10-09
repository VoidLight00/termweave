import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const staging = process.env.HERDR_STAGING_DIST;
const root = process.env.TERMWEAVE_TEST_ROOT;
if (!staging || !root || !process.env.HERDR_TEST_SESSION || process.env.HERDR_TEST_LIVE === '1') throw new Error('Staging tests require an owned isolated root');
if (!existsSync(staging) || !realpathSync(staging).startsWith(realpathSync(root) + '/')) throw new Error('Staging assets escape the owned test root');
process.env.HERDR_STAGING_DIST = resolve(staging);
