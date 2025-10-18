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
npx dep-graph graph
npx dep-graph index
npx dep-graph goto src/index.ts 10 5
npx dep-graph refs --file src/index.ts --line 10 --col 5
```

### Programmatic Usage

```typescript
import { buildProjectIndex, goToDefinition, findReferences } from "dep-graph";

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

To release a new version:

1. Make your changes
2. Build and test locally: `npm run build`
3. Commit: `git commit -am "your changes"`
4. Tag: `git tag v1.0.1`
5. Push: `git push origin main && git push origin v1.0.1`

Users can then update to the new version:

```powershell
npm install github:your-username/dep-graph#v1.0.1
```

## Alternative: Commit dist/

If you prefer not to use the `prepare` script (which builds during install):

1. Remove the `"prepare": "npm run build"` line from `package.json`
2. Run `npm run build` locally before each commit
3. Remove `dist` from `.gitignore`
4. Commit the `dist/` directory: `git add -f dist && git commit -m "build: add dist"`

This way, consumers get pre-built code and don't need to build during install.
