import * as path from "path";

/**
 * Pure OData query-construction helpers, kept dependency-free so they can be
 * unit tested without a VS Code or network environment.
 */

/** Doubles single quotes per OData string literal escaping rules. */
export function escapeODataString(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Escapes a value for use as an OData string literal AND URL-encodes it so
 * that characters like `&`, `#`, or spaces cannot corrupt the surrounding
 * query string (queries here are built by string concatenation, not a URL
 * builder). `encodeURIComponent` leaves `'` untouched, so the doubled quotes
 * from `escapeODataString` survive intact.
 */
export function encodeODataLiteral(value: string): string {
    return encodeURIComponent(escapeODataString(value));
}

const WEB_RESOURCE_TYPE_BY_EXTENSION: Record<string, number> = {
    ".html": 1,
    ".htm": 1,
    ".css": 2,
    ".js": 3,
    ".xml": 4,
    ".png": 5,
    ".jpg": 6,
    ".jpeg": 6,
    ".gif": 7,
    ".xap": 8,
    ".xsl": 9,
    ".xslt": 9,
    ".ico": 10,
    ".svg": 11,
    ".resx": 12,
};

/** Maps a file name's extension to the Dataverse web resource type code. */
export function getWebResourceTypeFromName(webResourceName: string): number {
    const extension = path.extname(webResourceName).toLowerCase();
    const webResourceType = WEB_RESOURCE_TYPE_BY_EXTENSION[extension];
    if (!webResourceType) {
        throw new Error(`Unsupported web resource file type '${extension || "(none)"}' for '${webResourceName}'.`);
    }
    return webResourceType;
}

/** Builds a reasonably unique multipart boundary token. */
export function createBoundary(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
