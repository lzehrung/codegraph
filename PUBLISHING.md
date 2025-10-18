# Publishing Guide

This package is configured to be installed directly from GitHub without needing to publish to npm.

## What Was Changed

### 1. package.json

- Added `main`, `types`, and `exports` fields pointing to `dist/` outputs
- Added `bin` field to expose the `dep-graph` CLI command
- Added `files` field to include only `dist/` in the package
- Added `build` script using TypeScript compiler
- Added `prepare` script to auto-build on install (so consumers get built code)
- Added `repository` field for GitHub URL
- Added `engines` field requiring Node.js 18+
- Updated `description` field

### 2. src/cli.ts

- Changed shebang from `#!/usr/bin/env tsx` to `#!/usr/bin/env node`
- This allows the built CLI in `dist/cli.js` to run directly

### 3. README.md

- Added installation instructions for GitHub-based installation
- Updated CLI usage examples to use `npx dep-graph` instead of `npx tsx src/cli.ts`
- Updated programmatic usage to import from `'dep-graph'` package
- Added section for local development

### 4. Build Verification

- Successfully built the project with `npm run build`
- Verified `dist/` contains all necessary files with correct shebang

## Next Steps: Publish to GitHub

### 1. Replace placeholder in package.json

Open `package.json` and replace `your-username` with your actual GitHub username:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/YOUR-ACTUAL-USERNAME/dep-graph.git"
}
```

Also update the same placeholder in `README.md` in the Installation section.

### 2. Commit your changes

```powershell
git add package.json src/cli.ts README.md PUBLISHING.md
git commit -m "feat: package as GitHub-installable module with CLI"
```

### 3. Tag a release

```powershell
git tag v1.0.0
```

### 4. Push to GitHub

```powershell
git push origin main
git push origin v1.0.0
```

## Installing in Other Projects

Once pushed to GitHub, you can install the package in any project:

### Option 1: Via npm command

```powershell
# Install latest from main branch
npm install github:your-username/dep-graph

# Install specific version tag
npm install github:your-username/dep-graph#v1.0.0

# Install specific commit
npm install github:your-username/dep-graph#abc1234
```

### Option 2: Add to package.json

```json
{
  "dependencies": {
    "dep-graph": "github:your-username/dep-graph#v1.0.0"
  }
}
```

Then run `npm install`.

## Using the Package

### CLI Usage

```powershell
# After installing in a project
npx codegraph graph
npx codegraph graph --mermaid > graph.mmd
npx codegraph index
npx codegraph goto src/index.ts 10 5
npx codegraph refs --file src/index.ts --line 10 --col 5
```

### Programmatic Usage

```typescript
import { buildProjectIndex, goToDefinition, findReferences } from "codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);

// Go to definition
const result = await goToDefinition(index, {
  file: "path/to/file.ts",
  line: 10,
  column: 5,
});

// Find references
const refs = await findReferences(index, {
  file: "path/to/file.ts",
  line: 10,
  column: 5,
});
```

## How It Works

1. **No npm publish required**: The package is installed directly from GitHub
2. **Auto-build on install**: The `prepare` script runs `npm run build` automatically when someone installs your package via GitHub
3. **Version pinning**: Use Git tags (like `v1.0.0`) to create stable versions
4. **Private repos supported**: Works with private repositories if the user has access

## Updating the Package

### Automated Release (Recommended)

Use npm's built-in `version` command to automatically bump version, run tests, build, commit, tag, and push:

```powershell
# Patch release (1.0.0 → 1.0.1) - bug fixes
npm run release:patch

# Minor release (1.0.0 → 1.1.0) - new features, backward compatible
npm run release:minor

# Major release (1.0.0 → 2.0.0) - breaking changes
npm run release:major
```

**What it does (zero dependencies, uses npm built-ins):**

1. **`preversion`** hook runs first:
   - ✓ Runs tests (`npm test`)
   - ✓ Builds the package (`npm run build`)
   - ✓ Fails if tests or build fail

2. **`npm version`** command:
   - ✓ Bumps version in package.json
   - ✓ Creates a git commit: `"v1.0.1"` or custom message
   - ✓ Creates a git tag (e.g., `v1.0.1`)

3. **`postversion`** hook runs after:
   - ✓ Pushes commits to GitHub
   - ✓ Pushes tags to GitHub

**Example workflow:**

```powershell
# 1. Make your changes
# Edit files, add features, fix bugs...

# 2. Commit your changes
git add .
git commit -m "feat: add new feature"

# 3. Run release (one command does everything!)
npm run release:minor

# Output:
# > codegraph@1.0.0 preversion
# > npm test && npm run build
#
# ✓ tests/... (X tests passed)
# > codegraph@1.0.0 build
# > tsc -p tsconfig.json
#
# v1.1.0
#
# > codegraph@1.1.0 postversion
# > git push && git push --tags
#
# To github.com:lzehrung/codegraph.git
#    abc1234..def5678  main -> main
#  * [new tag]         v1.1.0 -> v1.1.0
```

**Benefits:**
- ✅ Zero additional dependencies
- ✅ Uses npm's native `version` command
- ✅ Works everywhere npm works
- ✅ Standard npm workflow
- ✅ Fails fast if tests or build break

### Manual Release

If you prefer manual control:

1. Make your changes
2. Build and test locally: `npm run build && npm test`
3. Update version in `package.json`
4. Commit: `git commit -am "chore: bump version to 1.0.1"`
5. Tag: `git tag v1.0.1`
6. Push: `git push origin main && git push origin v1.0.1`

### Installing a Specific Version

Users can then install the new version:

```powershell
npm install github:lzehrung/codegraph#v1.0.1
```

## Alternative: Commit dist/

If you prefer not to use the `prepare` script (which builds during install):

1. Remove the `"prepare": "npm run build"` line from `package.json`
2. Run `npm run build` locally before each commit
3. Remove `dist` from `.gitignore`
4. Commit the `dist/` directory: `git add -f dist && git commit -m "build: add dist"`

This way, consumers get pre-built code and don't need to build during install.
