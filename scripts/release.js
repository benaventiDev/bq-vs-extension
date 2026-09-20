// Prepares a release PR. Publishing itself happens in CI: merging a PR that
// bumps the version into `main` is what ships it to the Marketplace (see
// .github/workflows/publish.yml).
//
// This script bumps package.json, opens a CHANGELOG section seeded from the
// commits since the last release, and pushes a `release/X.Y.Z` branch —
// opening the PR too when the GitHub CLI is available.
//
//   npm run release -- patch      0.3.2 -> 0.3.3
//   npm run release -- minor      0.3.2 -> 0.4.0
//   npm run release -- major      0.3.2 -> 1.0.0
//   npm run release -- 0.4.1      explicit version
//   npm run release -- minor --dry-run    show everything, change nothing
//
// Nothing here publishes, and nothing lands on `main` — the PR is the review
// gate, and merging it is the deliberate "ship this" step.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const BASE_BRANCH = 'main';
const WORK_BRANCH = 'dev';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpArg = args.find((a) => !a.startsWith('--'));

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!bumpArg) {
  fail('Usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]');
}

// --- Preflight -------------------------------------------------------------

const status = git('status', '--porcelain');
if (status) fail('Working tree is not clean. Commit or stash first:\n' + status);

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== WORK_BRANCH && branch !== BASE_BRANCH) {
  fail(`On branch "${branch}". Cut releases from "${WORK_BRANCH}" (or "${BASE_BRANCH}").`);
}

const current = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version;

function nextVersion(from, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = from.split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  return fail(`Unrecognized version bump: ${how}`);
}

const version = nextVersion(current, bumpArg);
const tag = `v${version}`;
const releaseBranch = `release/${version}`;

if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists — ${version} has shipped.`);

console.log(`Preparing ${current} -> ${version}${dryRun ? ' (dry run)' : ''}`);

// --- Seed the CHANGELOG from the commits since the last release ------------

let lastTag = '';
try {
  lastTag = git('describe', '--tags', '--abbrev=0');
} catch {
  // No tags yet — the first releases were published by hand. Fall back to
  // the whole history.
}
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = git('log', range, '--no-merges', '--format=- %s').split('\n').filter(Boolean);

console.log(`\nCommits since ${lastTag || 'the beginning'}:`);
for (const c of commits) console.log(`  ${c}`);

const today = new Date().toISOString().slice(0, 10);
const section = `## [${version}] - ${today}\n\n### Changed\n${commits.join('\n')}\n`;

if (dryRun) {
  console.log(`\n[dry-run] package.json version -> ${version}`);
  console.log(`[dry-run] branch ${releaseBranch} would be pushed`);
  console.log(`[dry-run] CHANGELOG.md would gain:\n\n${section}`);
  process.exit(0);
}

// --- Write the files -------------------------------------------------------

// package.json is edited by string replacement rather than JSON.stringify so
// the file's existing formatting and key order survive untouched — it is
// 190+ lines of contributed VS Code manifest.
const pkgRaw = fs.readFileSync(PKG_PATH, 'utf8');
const bumped = pkgRaw.replace(`"version": "${current}"`, `"version": "${version}"`);
if (bumped === pkgRaw) fail(`Could not find "version": "${current}" in package.json.`);
fs.writeFileSync(PKG_PATH, bumped);

const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
const firstEntry = changelog.indexOf('## [');
const updated =
  firstEntry === -1
    ? `${changelog.trimEnd()}\n\n${section}`
    : changelog.slice(0, firstEntry) + section + '\n' + changelog.slice(firstEntry);
fs.writeFileSync(CHANGELOG_PATH, updated);

// --- Branch, commit, push --------------------------------------------------

git('checkout', '-b', releaseBranch);
git('add', 'package.json', 'CHANGELOG.md');
git('commit', '-m', `Release ${version}`);
git('push', '-u', 'origin', releaseBranch);

console.log(`\nPushed ${releaseBranch}.`);

// Opening the PR is a convenience, not a requirement — skip it quietly if the
// GitHub CLI is not installed or not authenticated.
try {
  const body =
    `Bumps the version to ${version}.\n\n` +
    `Merging this into \`${BASE_BRANCH}\` publishes ${version} to the Visual Studio Marketplace.\n\n` +
    `### Changelog\n\n${commits.join('\n')}\n`;
  const url = execFileSync(
    'gh',
    ['pr', 'create', '--base', BASE_BRANCH, '--head', releaseBranch, '--title', `Release ${version}`, '--body', body],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  console.log(`Opened PR: ${url}`);
} catch {
  console.log('Open a PR from that branch into main to publish.');
}

console.log('\nReview the CHANGELOG section in the PR before merging —');
console.log('the merge is what ships it.');
