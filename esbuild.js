const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const extensionConfig = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  outfile: path.join(__dirname, 'out/extension.js'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
};

const webviewConfig = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/webview/index.ts')],
  outfile: path.join(__dirname, 'out/webview/index.js'),
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  loader: {
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.gif': 'dataurl',
    // Monaco ships an icon font (codicon.ttf) referenced from its CSS. We
    // inline as data: so the webview's strict CSP (no font URLs from
    // outside webview.cspSource) doesn't block it.
    '.ttf': 'dataurl',
  },
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[esbuild] watching...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log('[esbuild] build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
