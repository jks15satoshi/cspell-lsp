import * as path from 'node:path';
import { domainToASCII } from 'node:url';

import { URI } from 'vscode-uri';

/**
 * Converts a non-file document URI to the path used by workspace matching.
 *
 * The path must stay virtual, so this does not resolve symlinks. Parsing with
 * `vscode-uri` matches cspell-lib's URI decoding, including encoded separators
 * such as `%2F`. POSIX must keep the decoded `uri.path` because `fsPath`
 * rewrites paths such as `/c:/work`; on Windows an authority names a UNC host
 * (`git://server/share/a` is `\\server\share\a`, not a current-drive path).
 *
 * The `platform` parameter exists for platform-independent tests.
 */
export function getDocumentUriPath(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  let parsed: URI;
  try {
    parsed = URI.parse(uri);
  } catch {
    return undefined;
  }

  if (platform !== 'win32') {
    return path.posix.isAbsolute(parsed.path) ? parsed.path : undefined;
  }

  const drivePath = parsed.path.replace(/^\/(?=[a-zA-Z]:)/, '');
  const nativePath = parsed.authority
    ? `\\\\${parsed.authority}${parsed.path}`.replace(/\//g, '\\')
    : drivePath.replace(/\//g, '\\');
  return path.win32.isAbsolute(nativePath) ? nativePath : undefined;
}

/**
 * Returns the value cspell-lib's ignore matcher should test.
 *
 * cspell-lib reduces non-file URIs to `uri.path`, which drops the authority
 * that names a UNC host on Windows. Passing the full UNC path keeps it
 * comparable with a UNC workspace root instead of resolving it against the
 * server process's current drive. cspell-glob still drops the host when it
 * makes the path relative to a glob root, so rooted globs from another server
 * must be removed by {@link getApplicableExclusionGlobs} first.
 *
 * The `platform` parameter exists for platform-independent tests.
 */
export function getExclusionTarget(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    platform !== 'win32' ||
    uri.startsWith('file:') ||
    uri.startsWith('stdin:')
  ) {
    return uri;
  }
  const uriPath = getDocumentUriPath(uri, platform);
  return uriPath?.startsWith('\\\\') ? uriPath : uri;
}

function isFileUrl(value: string): boolean {
  return /^file:/i.test(value);
}

/**
 * Canonicalizes a UNC server name for identity comparisons.
 *
 * File URLs expose an IDN host as lower-case ASCII, while a native UNC path
 * keeps the Unicode name the client supplied. Both sides must use the same
 * representation so the same server is not mistaken for a different one.
 * Invalid host names keep the previous case-insensitive behavior.
 */
function canonicalizeUncServer(server: string): string {
  return (domainToASCII(server) || server).toLowerCase();
}

/**
 * Extracts the host from a Windows UNC path or file URL, if it is one.
 *
 * The returned host is canonicalized for comparison: IDN names become ASCII
 * and ASCII case is folded. The host identifies the network destination, so
 * only servers named by a workspace alias are allowed to reach the real-path
 * fallback.
 */
export function getUncServer(filePath: string): string | undefined {
  if (isFileUrl(filePath)) {
    try {
      const url = new URL(filePath);
      // Node's URL parser leaves a UNC host in the path for file:////host URLs.
      const fixed = url.href.startsWith('file:////')
        ? new URL(url.href.replace(/^file:\/{4}/, 'file://'))
        : url;
      return fixed.hostname ? canonicalizeUncServer(fixed.hostname) : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return undefined;

  const normalized = filePath.replace(/\//g, '\\');
  const unc = normalized.startsWith('\\\\?\\UNC\\')
    ? `\\\\${normalized.slice(8)}`
    : normalized;
  if (unc.startsWith('\\\\?\\')) return undefined;
  const root = path.win32.parse(unc).root;
  if (!root.startsWith('\\\\')) return undefined;
  const [server] = root.split(path.win32.sep).filter(Boolean);
  return server ? canonicalizeUncServer(server) : undefined;
}
