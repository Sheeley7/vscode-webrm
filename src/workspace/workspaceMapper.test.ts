import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
    resolveWebResourcePath,
    splitWebResourceNameSafely,
    splitResourceFolderAndFile,
    toWebResourceName,
    UnsafeWebResourceNameError,
} from "./workspaceMapper";

const ROOT = path.normalize(process.platform === "win32" ? "C:\\workspace" : "/workspace");

test("resolveWebResourcePath joins a simple nested name under the root", () => {
    const resolved = resolveWebResourcePath(ROOT, "new_/scripts/account.js");
    assert.equal(resolved, path.normalize(path.join(ROOT, "new_", "scripts", "account.js")));
});

test("resolveWebResourcePath rejects parent-directory traversal", () => {
    assert.throws(() => resolveWebResourcePath(ROOT, "../../etc/passwd"), UnsafeWebResourceNameError);
});

test("resolveWebResourcePath rejects a traversal segment buried mid-path", () => {
    assert.throws(() => resolveWebResourcePath(ROOT, "scripts/../../outside.js"), UnsafeWebResourceNameError);
});

test("resolveWebResourcePath rejects an absolute/rooted segment", () => {
    assert.throws(() => resolveWebResourcePath(ROOT, "/etc/passwd"), UnsafeWebResourceNameError);
    assert.throws(() => resolveWebResourcePath(ROOT, "C:/Windows/system32/evil.dll"), UnsafeWebResourceNameError);
});

test("resolveWebResourcePath rejects a backslash-containing segment", () => {
    assert.throws(() => resolveWebResourcePath(ROOT, "scripts\\..\\..\\evil.js"), UnsafeWebResourceNameError);
});

test("resolveWebResourcePath rejects empty and dot segments", () => {
    assert.throws(() => resolveWebResourcePath(ROOT, "scripts//account.js"), UnsafeWebResourceNameError);
    assert.throws(() => resolveWebResourcePath(ROOT, "./account.js"), UnsafeWebResourceNameError);
    assert.throws(() => resolveWebResourcePath(ROOT, ""), UnsafeWebResourceNameError);
});

test("splitWebResourceNameSafely splits a valid name into segments", () => {
    assert.deepEqual(splitWebResourceNameSafely("new_/scripts/account.js"), ["new_", "scripts", "account.js"]);
});

test("splitResourceFolderAndFile separates folder segments from the file name", () => {
    assert.deepEqual(splitResourceFolderAndFile("new_/scripts/account.js"), {
        folderSegments: ["new_", "scripts"],
        fileName: "account.js",
    });
    assert.deepEqual(splitResourceFolderAndFile("account.js"), {
        folderSegments: [],
        fileName: "account.js",
    });
});

test("toWebResourceName converts a contained local path back to a logical name", () => {
    const filePath = path.join(ROOT, "new_", "scripts", "account.js");
    assert.equal(toWebResourceName(ROOT, filePath), "new_/scripts/account.js");
});

test("toWebResourceName returns undefined for a path outside the root", () => {
    const outsidePath = path.resolve(ROOT, "..", "elsewhere", "file.js");
    assert.equal(toWebResourceName(ROOT, outsidePath), undefined);
});

test("toWebResourceName returns undefined for the root itself (no relative name)", () => {
    assert.equal(toWebResourceName(ROOT, ROOT), undefined);
});
