import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildGetBatchBody,
    buildPatchBatchBody,
    parseBatchResponseItems,
    parseBatchJsonResponses,
} from "./batchUtils";

test("buildGetBatchBody embeds each relative URL as an inner GET request", () => {
    const body = buildGetBatchBody("batch_123", "/api/data/v9.2/", [
        { relativeUrl: "webresourceset(aaa)?$select=content" },
        { relativeUrl: "webresourceset(bbb)?$select=content" },
    ]);
    assert.ok(body.includes("GET /api/data/v9.2/webresourceset(aaa)?$select=content HTTP/1.1"));
    assert.ok(body.includes("GET /api/data/v9.2/webresourceset(bbb)?$select=content HTTP/1.1"));
    assert.ok(body.trim().endsWith("--batch_123--"));
});

test("buildPatchBatchBody includes If-Match only when an etag is provided", () => {
    const body = buildPatchBatchBody("batch_456", "/api/data/v9.2/", [
        { relativeUrl: "webresourceset(aaa)", body: { content: "AAAA" }, ifMatch: 'W/"123"' },
        { relativeUrl: "webresourceset(bbb)", body: { content: "BBBB" } },
    ]);
    assert.ok(body.includes('If-Match: W/"123"'));
    assert.ok(body.includes("PATCH /api/data/v9.2/webresourceset(aaa) HTTP/1.1"));
    assert.ok(body.includes("PATCH /api/data/v9.2/webresourceset(bbb) HTTP/1.1"));
    assert.ok(body.includes('{"content":"AAAA"}'));
    assert.ok(body.includes('{"content":"BBBB"}'));
});

function fakeBatchResponse(statuses: Array<{ status: number; body?: object }>): string {
    const parts: string[] = [];
    for (const item of statuses) {
        parts.push(
            "--batchresponse_abc123",
            "Content-Type: application/http",
            "",
            `HTTP/1.1 ${item.status} ${item.status === 200 ? "OK" : "Error"}`,
            "Content-Type: application/json",
            "",
            item.body ? JSON.stringify(item.body) : "",
        );
    }
    parts.push("--batchresponse_abc123--");
    return parts.join("\r\n");
}

test("parseBatchResponseItems extracts status and payload per inner response", () => {
    const responseText = fakeBatchResponse([
        { status: 200, body: { content: "AAAA" } },
        { status: 204 },
    ]);
    const items = parseBatchResponseItems(responseText, 2);
    assert.equal(items.length, 2);
    assert.equal(items[0].status, 200);
    assert.deepEqual(items[0].payload, { content: "AAAA" });
    assert.equal(items[1].status, 204);
    assert.equal(items[1].payload, undefined);
});

test("parseBatchResponseItems throws when the response count does not match expected", () => {
    const responseText = fakeBatchResponse([{ status: 200, body: {} }]);
    assert.throws(() => parseBatchResponseItems(responseText, 2));
});

test("parseBatchJsonResponses throws on a non-2xx inner status", () => {
    const responseText = fakeBatchResponse([{ status: 404 }]);
    assert.throws(() => parseBatchJsonResponses(responseText, 1));
});

test("parseBatchJsonResponses returns payloads in request order for all-success responses", () => {
    const responseText = fakeBatchResponse([
        { status: 200, body: { content: "first" } },
        { status: 200, body: { content: "second" } },
    ]);
    const payloads = parseBatchJsonResponses(responseText, 2);
    assert.deepEqual(payloads, [{ content: "first" }, { content: "second" }]);
});
