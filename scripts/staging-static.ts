import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalPath, isWithin } from './lifecycle-path.ts';

const staging = process.env.HERDR_STAGING_DIST;
const root = process.env.TERMWEAVE_TEST_ROOT;
if (!staging || !root || !process.env.HERDR_TEST_SESSION || process.env.HERDR_TEST_LIVE === '1') throw new Error('Staging tests require an owned isolated root');
// Strictly inside the owned root (the root itself is refused), compared by canonical identity on the platform separator.
const inside = (parent: string, child: string) => child !== parent && isWithin(parent, child);
if (!existsSync(staging)) throw new Error('Staging assets are missing; the build lane writes them into the owned test root');
if (!inside(canonicalPath(root), canonicalPath(staging))) throw new Error('Staging assets escape the owned test root');
process.env.HERDR_STAGING_DIST = resolve(staging);
