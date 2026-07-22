/**
 * Pure helpers for building and parsing OData `$batch` multipart/mixed
 * request and response bodies. Kept dependency-free so batch parsing can be
 * unit tested without a network or VS Code environment.
 */

const CRLF = "\r\n";

export interface BatchGetRequest {
    /** Path + query appended after the API version segment, e.g. "webresourceset(id)?$select=...". */
    relativeUrl: string;
}

export interface BatchPatchRequest {
    relativeUrl: string;
    body: unknown;
    /** Optional `If-Match` value for optimistic concurrency (an OData `@odata.etag`). */
    ifMatch?: string;
}

function apiPath(apiDataPrefix: string, relativeUrl: string): string {
    return `${apiDataPrefix}${relativeUrl}`;
}

export function buildGetBatchBody(boundary: string, apiDataPrefix: string, requests: BatchGetRequest[]): string {
    const parts: string[] = [];
    for (const request of requests) {
        parts.push(
            `--${boundary}`,
            "Content-Type: application/http",
            "Content-Transfer-Encoding: binary",
            "",
            `GET ${apiPath(apiDataPrefix, request.relativeUrl)} HTTP/1.1`,
            "Accept: application/json",
            "",
        );
    }
    return [...parts, `--${boundary}--`, ""].join(CRLF);
}

export function buildPatchBatchBody(boundary: string, apiDataPrefix: string, requests: BatchPatchRequest[]): string {
    const parts: string[] = [];
    for (const request of requests) {
        const headerLines = [
            "Content-Type: application/json; type=entry",
        ];
        if (request.ifMatch) {
            headerLines.push(`If-Match: ${request.ifMatch}`);
        }
        parts.push(
            `--${boundary}`,
            "Content-Type: application/http",
            "Content-Transfer-Encoding: binary",
            "",
            `PATCH ${apiPath(apiDataPrefix, request.relativeUrl)} HTTP/1.1`,
            ...headerLines,
            "",
            JSON.stringify(request.body)
        );
    }
    return [...parts, `--${boundary}--`, ""].join(CRLF);
}

/** One inner response's parsed HTTP status and (if present) JSON payload. */
export interface BatchResponseItem {
    status: number;
    payload?: unknown;
}

/**
 * Splits a `$batch` multipart response into its inner HTTP responses.
 * Tolerant of the exact boundary token (Dataverse always prefixes inner
 * response boundaries with `batchresponse_`, but the suffix varies).
 */
export function parseBatchResponseItems(responseText: string, expectedCount: number): BatchResponseItem[] {
    const sections = responseText.split(/--batchresponse_[^\r\n]+/g);
    const items: BatchResponseItem[] = [];

    for (const section of sections) {
        const statusMatch = section.match(/HTTP\/1\.1\s+(\d{3})/);
        if (!statusMatch) {
            continue;
        }

        const status = Number(statusMatch[1]);
        const jsonStart = section.indexOf("{");
        const jsonEnd = section.lastIndexOf("}");
        const payload = jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart
            ? JSON.parse(section.slice(jsonStart, jsonEnd + 1))
            : undefined;

        items.push({ status, payload });
    }

    if (items.length !== expectedCount) {
        throw new Error(`Batch response returned ${items.length} responses for ${expectedCount} requests: ${responseText}`);
    }

    return items;
}

/** Same as `parseBatchResponseItems`, but throws on any non-2xx inner status and returns only payloads. */
export function parseBatchJsonResponses(responseText: string, expectedCount: number): unknown[] {
    const items = parseBatchResponseItems(responseText, expectedCount);
    return items.map(item => {
        if (item.status < 200 || item.status >= 300) {
            throw new Error(`Batch retrieval returned inner HTTP status ${item.status}: ${responseText}`);
        }
        if (item.payload === undefined) {
            throw new Error(`Batch retrieval response did not include a JSON payload: ${responseText}`);
        }
        return item.payload;
    });
}
