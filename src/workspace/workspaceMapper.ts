import * as path from "path";

/**
 * Pure, VS Code-independent helpers for converting between Dataverse logical
 * web-resource names (always '/'-separated) and local file system paths.
 *
 * Every function here rejects traversal/absolute segments and verifies the
 * resolved path stays under the given workspace root, since logical names
 * are server-provided data and must not be trusted to build safe paths.
 */

export class UnsafeWebResourceNameError extends Error {
    constructor(webResourceName: string, reason: string) {
        super(`Web resource name '${webResourceName}' is not a safe local path (${reason}).`);
        this.name = "UnsafeWebResourceNameError";
    }
}

/**
 * Splits a logical web resource name into path segments, rejecting anything
 * that could escape the workspace root (empty segments, '.', '..', or an
 * absolute/rooted segment).
 */
export function splitWebResourceNameSafely(webResourceName: string): string[] {
    if (!webResourceName || webResourceName.trim() === "") {
        throw new UnsafeWebResourceNameError(webResourceName, "empty name");
    }

    const segments = webResourceName.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new UnsafeWebResourceNameError(webResourceName, `invalid path segment '${segment}'`);
        }
        if (path.isAbsolute(segment) || /^[a-zA-Z]:/.test(segment) || segment.includes("\\")) {
            throw new UnsafeWebResourceNameError(webResourceName, `rooted or backslash-containing segment '${segment}'`);
        }
    }
    return segments;
}

/**
 * Resolves a logical web resource name to an absolute local path under
 * `workspaceRoot`, guaranteeing the result stays within that root.
 * Throws `UnsafeWebResourceNameError` if the name is invalid or would
 * resolve outside the workspace root.
 */
export function resolveWebResourcePath(workspaceRoot: string, webResourceName: string): string {
    const segments = splitWebResourceNameSafely(webResourceName);
    const normalizedRoot = path.normalize(workspaceRoot);
    const resolved = path.normalize(path.join(normalizedRoot, ...segments));

    const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
        throw new UnsafeWebResourceNameError(webResourceName, "resolved path escapes the workspace root");
    }
    return resolved;
}

/**
 * Splits a resolved local path into (folder segments, file name) for callers
 * that need to create parent directories before writing the file.
 */
export function splitResourceFolderAndFile(webResourceName: string): { folderSegments: string[]; fileName: string } {
    const segments = splitWebResourceNameSafely(webResourceName);
    const fileName = segments[segments.length - 1];
    return { folderSegments: segments.slice(0, -1), fileName };
}

/**
 * Converts a local file path back into a logical web resource name relative
 * to `workspaceRoot`, using '/' separators. Returns undefined if `filePath`
 * is not contained within `workspaceRoot`.
 */
export function toWebResourceName(workspaceRoot: string, filePath: string): string | undefined {
    const normalizedRoot = path.normalize(workspaceRoot);
    const normalizedFile = path.normalize(filePath);
    const relativePath = path.relative(normalizedRoot, normalizedFile);

    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return undefined;
    }
    return relativePath.split(path.sep).join("/");
}
