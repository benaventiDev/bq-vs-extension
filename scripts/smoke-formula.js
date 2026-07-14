// Quick smoke-test for the formula lexer/parser/evaluator. Bundles the
// formula module via esbuild and exercises a handful of cases against a
// synthetic row. Not a unit-test framework — just a self-checking script
// to make sure the language behaves as documented before wiring the UI.

const esbuild = require('esbuild');
const path = require('path');

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'formula', 'parser.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    write: false,
    logLevel: 'warning',
  });
  // Build evaluator separately since we need both.
  const evalResult = await esbuild.build({
    entryPoints: [path.join(__dirname, 'inline-formula-runner.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    write: false,
    logLevel: 'warning',
  });
  const code = evalResult.outputFiles[0].text;
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  const mod = { exports: {} };
  fn(mod, mod.exports, require);
  const run = mod.exports.run;
  if (typeof run !== 'function') throw new Error('run not exported');
  const ok = run();
  void result;
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
