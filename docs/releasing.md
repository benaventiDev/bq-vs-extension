# Releasing

Publishing to the Visual Studio Marketplace is automated. Nothing is published
from a developer machine, and no Marketplace token lives outside GitHub.

## Branches

| Branch            | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `main`            | Release branch. Protected. Reached only through a merged PR.         |
| `dev`             | Integration branch. Day-to-day work lands here.                      |
| `feature/*`, `fix/*` | Individual changes, branched off `dev` and PR'd back into it.     |

## What actually triggers a publish

A merge into `main` **does not** publish on its own.

`.github/workflows/publish.yml` runs on every push to `main`, reads the version
from `package.json`, and checks whether a `v<version>` git tag already exists:

- **Tag exists** → that version already shipped. The workflow stops. This is
  the normal case for merging a fix or a docs change.
- **No tag** → the version is new. The workflow builds, publishes to the
  Marketplace, tags `v<version>`, and creates a GitHub Release with the
  `.vsix` attached.

So the version number in `package.json` is the publish switch, and changing it
is a reviewable line in a diff rather than a button someone remembers to press.

## Cutting a release

From `dev`, with a clean working tree:

```bash
npm run release -- minor        # or: patch | major | 0.4.1
```

That bumps `package.json`, opens a `CHANGELOG.md` section seeded from the
commits since the last release, pushes a `release/X.Y.Z` branch, and opens a PR
into `main` (if the GitHub CLI is installed).

Add `--dry-run` to see all of it without changing anything.

Then: read the generated CHANGELOG section in the PR and reword it — those raw
commit subjects become the public release notes. Merging the PR publishes.

## One-time setup

1. Create a Marketplace Personal Access Token in Azure DevOps
   (organization: **all accessible organizations**, scope: **Marketplace →
   Manage**).
2. Add it to the repo as a secret named `VSCE_PAT`:
   Settings → Secrets and variables → Actions → New repository secret.
3. Protect `main`: Settings → Branches → require a PR before merging, and
   require the `CI` status check to pass.

## If a publish fails

The tag is only written *after* a successful upload, so a failed publish leaves
the version untagged and can simply be retried: re-run the workflow from the
Actions tab (`Run workflow` on **Publish to Marketplace**).
