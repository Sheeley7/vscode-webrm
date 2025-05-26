// esbuild.config.js
const { build } = require('esbuild');

build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: ['node18'],
  outfile: 'dist/extension.js',
  external: [
    'vscode', // Only VS Code API must be external
  ],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
}).catch(() => process.exit(1));
