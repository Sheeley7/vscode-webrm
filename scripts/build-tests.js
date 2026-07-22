// Compiles src/**/*.test.ts (pure, VS Code-independent logic only) to CommonJS
// under test-out/, mirroring the src/ layout, so `node --test` can run them
// with Node's built-in test runner. Each test file is bundled together with
// the pure modules it imports (path/crypto built-ins only, no `vscode`),
// so the output is self-contained without needing to compile all of src/.
const { buildSync } = require('esbuild');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const outDir = path.join(__dirname, '..', 'test-out');

function findTestFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findTestFiles(full, out);
        } else if (entry.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out;
}

const testFiles = findTestFiles(srcDir);
if (testFiles.length === 0) {
    console.log('No *.test.ts files found under src/.');
    process.exit(0);
}

buildSync({
    entryPoints: testFiles,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node20'],
    outdir: outDir,
    outbase: srcDir,
    logLevel: 'info',
    // node:test/node:assert are resolved at runtime; nothing else should be external,
    // since test files must only import pure, dependency-free sibling modules.
    external: ['node:test', 'node:assert', 'node:assert/strict'],
});
