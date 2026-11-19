// Bundles test/**/*.test.ts with esbuild and runs them with node:test.
//   node scripts/test.js            unit tests only
//   node scripts/test.js --live     also the live Snowflake tests (uses your
//                                   default Snowflake connection; creates
//                                   objects only inside the BQX_TEST database)
//   node scripts/test.js <filter>   only test files whose name contains <filter>
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
const outDir = path.join(root, 'out-test');
const args = process.argv.slice(2);
const live = args.includes('--live');
const filter = args.find((a) => !a.startsWith('--'));

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return collect(p);
    return e.name.endsWith('.test.ts') ? [p] : [];
  });
}

let files = collect(testDir).filter((f) => !filter || path.basename(f).includes(filter));
if (!live) files = files.filter((f) => !f.includes(`${path.sep}live${path.sep}`));

fs.rmSync(outDir, { recursive: true, force: true });
esbuild.buildSync({
  entryPoints: files,
  outdir: outDir,
  outbase: testDir,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: 'inline',
  external: ['vscode'],
  logLevel: 'warning',
});

const outFiles = files.map((f) => path.join(outDir, path.relative(testDir, f)).replace(/\.ts$/, '.js'));
const res = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', ...outFiles], {
  stdio: 'inherit',
  env: { ...process.env, BQX_LIVE: live ? '1' : '' },
});
process.exit(res.status ?? 1);
