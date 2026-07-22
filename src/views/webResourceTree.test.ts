import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResourceTree } from "./webResourceTree";

test("buildResourceTree creates a flat file list with no nesting for top-level names", () => {
    const tree = buildResourceTree([
        { name: "b.js", id: "2" },
        { name: "a.js", id: "1" },
    ]);
    assert.equal(tree.length, 2);
    assert.deepEqual(tree.map(node => node.name), ["a.js", "b.js"]);
    assert.ok(tree.every(node => node.type === "file"));
});

test("buildResourceTree nests files under shared folder segments", () => {
    const tree = buildResourceTree([
        { name: "new_/scripts/account.js", id: "1" },
        { name: "new_/scripts/contact.js", id: "2" },
        { name: "new_/styles/site.css", id: "3" },
    ]);

    assert.equal(tree.length, 1);
    const root = tree[0];
    assert.equal(root.type, "folder");
    assert.equal(root.name, "new_");
    assert.equal(root.children.length, 2);

    const [scripts, styles] = root.children;
    assert.equal(scripts.name, "scripts");
    assert.equal(scripts.type, "folder");
    assert.equal(styles.name, "styles");
    assert.equal(styles.type, "folder");

    assert.deepEqual(scripts.children.map(c => c.name), ["account.js", "contact.js"]);
    assert.equal(scripts.children[0].fullPath, "new_/scripts/account.js");
    assert.equal(scripts.children[0].id, "1");
});

test("buildResourceTree sorts folders before files, alphabetically within each group", () => {
    const tree = buildResourceTree([
        { name: "zzz.js", id: "1" },
        { name: "aaa_folder/inner.js", id: "2" },
        { name: "aaa.js", id: "3" },
    ]);
    assert.deepEqual(tree.map(node => `${node.type}:${node.name}`), [
        "folder:aaa_folder",
        "file:aaa.js",
        "file:zzz.js",
    ]);
});

test("buildResourceTree sort is case-insensitive", () => {
    const tree = buildResourceTree([
        { name: "Banana.js", id: "1" },
        { name: "apple.js", id: "2" },
    ]);
    assert.deepEqual(tree.map(node => node.name), ["apple.js", "Banana.js"]);
});
