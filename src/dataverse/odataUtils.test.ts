import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeODataString, encodeODataLiteral, getWebResourceTypeFromName, createBoundary } from "./odataUtils";

test("escapeODataString doubles single quotes", () => {
    assert.equal(escapeODataString("O'Brien's Solution"), "O''Brien''s Solution");
    assert.equal(escapeODataString("no quotes here"), "no quotes here");
});

test("encodeODataLiteral escapes quotes and URL-encodes the result", () => {
    // A raw apostrophe in a filter value must not break out of the OData string literal,
    // and characters like '&' or '#' must not break the surrounding query string.
    assert.equal(encodeODataLiteral("O'Brien"), "O''Brien");
    assert.equal(encodeODataLiteral("A & B # C"), encodeURIComponent("A & B # C"));
    assert.ok(!encodeODataLiteral("A & B").includes("&"));
});

test("getWebResourceTypeFromName maps known extensions to Dataverse type codes", () => {
    assert.equal(getWebResourceTypeFromName("account.js"), 3);
    assert.equal(getWebResourceTypeFromName("styles/site.css"), 2);
    assert.equal(getWebResourceTypeFromName("index.html"), 1);
    assert.equal(getWebResourceTypeFromName("logo.PNG"), 5);
});

test("getWebResourceTypeFromName throws for an unsupported or missing extension", () => {
    assert.throws(() => getWebResourceTypeFromName("README"));
    assert.throws(() => getWebResourceTypeFromName("archive.zip"));
});

test("createBoundary produces distinct, prefixed tokens", () => {
    const a = createBoundary("batch");
    const b = createBoundary("batch");
    assert.ok(a.startsWith("batch_"));
    assert.notEqual(a, b);
});
