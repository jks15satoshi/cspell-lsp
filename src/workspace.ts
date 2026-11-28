import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InitializeParams } from 'vscode-languageserver/node.js';

/**
 * Collects unique workspace roots from LSP initialization parameters.
 */
export function collectWorkspaceRoots(params: InitializeParams): string[] {
  const roots: string[] = [];
  for (const folder of params.workspaceFolders ?? []) {
    const root = safeFileURLToPath(folder.uri);
    if (root) roots.push(path.resolve(root));
  }
  if (roots.length === 0 && params.rootUri) {
    const root = safeFileURLToPath(params.rootUri);
    if (root) roots.push(path.resolve(root));
  }
  if (roots.length === 0 && params.rootPath) {
    roots.push(path.resolve(params.rootPath));
  }
  return [...new Set(roots)];
}

/**
 * Converts a local file URI to a path, or undefined for other URIs.
 */
export function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}
