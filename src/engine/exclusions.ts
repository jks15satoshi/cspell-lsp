import * as path from 'node:path';

import { normalizeGlobPatterns } from 'cspell-glob';
import type { Glob } from 'cspell-lib';

import { getUncServer } from './documentPaths.js';

/**
 * Returns the ignore globs whose roots can apply to an exclusion target.
 *
 * cspell-glob makes a file URL relative to a glob root by comparing only the
 * pathname, so a glob rooted at `\\server-a\share` also matches
 * `\\server-b\share`. A rooted glob on another UNC server must not apply.
 * Roots are normalized first because cspell-glob resolves `${cwd}`, relative
 * roots, and four-slash UNC file URLs before matching. Global patterns stay
 * root independent.
 *
 * The `platform` and `cwd` parameters exist for platform-independent tests.
 */
export function getApplicableExclusionGlobs(
  globs: readonly Glob[],
  fallbackRoot: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): Glob[] {
  if (platform !== 'win32') return [...globs];
  const documentServer = getUncServer(target);
  if (!documentServer) return [...globs];

  return globs.filter((glob) => {
    const [normalized] = normalizeGlobPatterns([glob], {
      root: fallbackRoot,
      cwd,
      nested: true,
      nodePath: path.win32,
    });
    if (!normalized || normalized.isGlobalPattern) return true;
    const rootServer = getUncServer(normalized.root);
    return !rootServer || rootServer === documentServer;
  });
}
