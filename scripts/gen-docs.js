// Generate docs/formula-language.md from src/formula/docs.ts.
// Uses esbuild to bundle the TypeScript source to a one-shot CJS module
// that exports buildMarkdown(), then writes the result to disk.
//
// Run with: node scripts/gen-docs.js

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'formula', 'generateMarkdown.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    write: false,
    logLevel: 'warning',
    // Strip the "if (require.main === module)" auto-run guard from running
    // during the eval below — esbuild doesn't tree-shake that, but our eval
    // strategy below bypasses it by reading the module's exports instead.
    define: { 'require.main': 'undefined' },
  });
  const code = result.outputFiles[0].text;
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  const mod = { exports: {} };
  fn(mod, mod.exports, require);
  const buildMarkdown = mod.exports.buildMarkdown;
  if (typeof buildMarkdown !== 'function') {
    throw new Error('buildMarkdown not found in generated module');
  }
  const out = path.join(__dirname, '..', 'docs', 'formula-language.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildMarkdown(), 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
