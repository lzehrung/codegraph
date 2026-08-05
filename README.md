[README.md#39BD]
1:# Codegraph
2:
3:[![Release](https://img.shields.io/github/v/release/lzehrung/codegraph?display_name=tag&sort=semver)](https://github.com/lzehrung/codegraph/releases/latest)
4:[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
5:[![Node.js](https://img.shields.io/badge/node-%3E%3D22.16-brightgreen.svg)](./package.json)
6:[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](./docs/mcp.md)
7:[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange.svg)](./CHANGELOG.md)
8:
9:**Give your coding agent a map of the repository, not a pile of search results.**
10:
11:Codegraph is a local CLI **and TypeScript library** that turns a source tree into a resolved model of files, symbols, references, and dependencies. Agents and humans can ask where an implementation lives, how components connect, what a change can break, and which tests are likely relevant - then get bounded source evidence and copyable next steps.
12:
13:Without structural context, an agent spends early turns listing directories, guessing search terms, opening candidate files, and reconstructing relationships in its prompt. Codegraph performs that deterministic discovery once so more of the context window can go toward understanding and changing the code.
14:
15:On this repository under Node 24 with a warm cache, `codegraph orient --root . --budget small --json` returned in about **0.6s**, and the matching MCP `orient` call returned in about **100ms**. Those are the warm first-turn paths worth optimizing for; broader `explore` / `explain` calls remain heavier and are tracked separately.
16:
17:Windows PowerShell:
18:
19:```powershell
20:irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
21:```
22:
23:macOS or glibc-based Linux:
24:
25:```bash
26:curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
27:```
28:
29:Then configure an agent and ask the first question:
30:
31:```bash
32:codegraph install
33:codegraph explore "how does auth reach the database?" --root .
34:```
35:
36:Use Codegraph alongside text search and compilers: text search finds exact strings, compilers prove language behavior, and Codegraph supplies the cross-file repository map between them. See [Installation](./docs/installation.md) for standalone, package, and source-checkout paths.
37:
38:## Table of contents
39:
40:- [Changelog](./CHANGELOG.md)
41:- [What you can do](#what-you-can-do)
42:- [Try it](#try-it)
43:- [A useful first five minutes](#a-useful-first-five-minutes)
44:- [Visualize a graph](#visualize-a-graph)
45:- [What the output looks like](#what-the-output-looks-like)
46:- [Why Codegraph](#why-codegraph)
47:- [Why not just grep or an LSP?](#why-not-just-grep-or-an-lsp)
48:- [Agent setup](#agent-setup)
49:- [Language support](#language-support)
50:- [Using as a library](#using-as-a-library)
51:- [How it works](#how-it-works)
52:- [Limits and tradeoffs](#limits-and-tradeoffs)
53:- [Documentation](./docs)
54:  - [CLI](./docs/cli.md)
55:  - [Publishing](./PUBLISHING.md)
56:- [Contributing](#contributing)
57:
58:## What you can do
59:
60:| Question                                     | Start here                                                       | What comes back                                                                              |
61:| -------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
62:| "Where should I start in this repo?"         | `codegraph orient --root . --budget small`                       | Central modules, a bounded tree, and copyable follow-ups                                     |
63:| "How does this feature work?"                | `codegraph explore "<question>" --root .`                        | Ranked anchors, source packets, dependency paths, blast radius, and likely tests             |
64:| "What could this change break?"              | `codegraph review --base HEAD --head WORKTREE`                   | Changed symbols, risk signals, candidate tests, duplicate leads, and review tasks            |
65:| "Which tests should I run?"                  | `codegraph affected --base HEAD --head WORKTREE --quiet`         | Deterministic affected test paths from changed files and reverse dependencies                |
66:| "What depends on this file?"                 | `codegraph rdeps src/file.ts --json`                             | Reverse dependencies from the resolved project graph                                         |
67:| "Where is this symbol defined or used?"      | `codegraph goto <file> <line> <column>` and `codegraph refs ...` | Semantic definitions and references across supported languages                               |
68:| "Which declaration matches this name?"       | `codegraph symbols "CodeReviewSession" --root .`                 | Ranked symbols with portable handles, exact ranges, provenance, and omissions                |
69:| "What evidence do I need before a refactor?" | `codegraph refactor-plan <symbol-target>`                        | References, call and type relationships, candidate tests, omissions, and copyable follow-ups |
70:| "Is the architecture drifting?"              | `codegraph drift ./src --base origin/main --head HEAD`           | New cycles, hotspot changes, unresolved imports, API changes, and graph deltas               |
71:| "Where is code duplicated?"                  | `codegraph duplicates ./src --min-confidence medium`             | Ranked exact and near-duplicate groups with locations and confidence                         |
72:| "Can another tool consume the graph?"        | `codegraph graph --root . ./src --json --output codegraph.json`  | JSON, Mermaid, DOT, or SQLite output                                                         |
73:
74:Human-readable output is the CLI default, including the compact `review` report; `--pretty` remains an explicit equivalent. Use `--json` for stable fields, ranges, handles, reasons, confidence, and omission counts in automation.
75:
76:## Try it
77:
78:**Requirement:** Package and source installs require Node.js 22.16 or newer. Standalone archives bundle Node.js.
79:
80:### Standalone archive
81:
82:The preview standalone channel bundles Node.js, the CLI, production dependencies, the matching native runtime, and the Codegraph skill. Its bootstrap verifies the selected archive against the release `SHA256SUMS` before extraction:
83:Standalone assets are attached by a separate post-release workflow, so use a release that lists the archive and installer assets.
84:
85:```powershell
86:irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
87:```
88:
89:```bash
90:curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
91:```
92:
93:Both commands preview the target and user-owned install paths, then default to no. Noninteractive automation must download the script and pass `-Yes` on PowerShell or `--yes` on POSIX.
94:
95:See [Installation](./docs/installation.md#option-1-standalone-release-preview) for supported targets, inspect-before-run commands, version pinning, install roots, and rollback.
96:
97:### From a source checkout
98:
99:This is the least ambiguous way to evaluate the current repository:
100:
101:```bash
102:git clone https://github.com/lzehrung/codegraph.git
103:cd codegraph
104:npm install
105:npm run build
106:
107:node ./dist/cli.js doctor
108:node ./dist/cli.js orient --root . --budget small
109:```
110:
111:Continue with `node ./dist/cli.js <command>` from the checkout. To use the bare `codegraph` examples below unchanged, run `npm install -g .` after the build, then `codegraph doctor` and `codegraph install --all --dry-run`.
112:
113:### From GitHub Packages
114:
115:After authenticating to GitHub Packages with a classic token that has `read:packages` ([setup](./docs/installation.md#option-3-install-from-the-lzehrung-registry)):
116:
117:```bash
118:npm login --scope=@lzehrung --auth-type=legacy --registry=https://npm.pkg.github.com
119:npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
120:npm install -g @lzehrung/codegraph
121:codegraph doctor
122:codegraph install --all --dry-run
123:codegraph install --all --yes
124:```
125:
126:Published package installs resolve the optional native runtime automatically when a compatible artifact exists. See [Installation](./docs/installation.md) for registry setup, npm tarballs, standalone releases, local global installs, and native runtime modes.
127:
128:On Windows, installed releases load the native addon from a verified per-user cache so long-running MCP servers do not keep npm's package copy mapped. The first upgrade from an older direct-loading release still requires one stop-update-restart cycle; see [Updating on Windows](./docs/installation.md#updating-on-windows).
129:
130:## A useful first five minutes
131:
132:Do not begin by generating every possible report. Start with the question you actually have.
133:
134:### Understand an unfamiliar repo
135:
136:```bash
137:# Ask one concrete architecture question
138:codegraph explore "how does the CLI reach review analysis?" --root .
139:
140:# If you do not know the question yet, get a bounded map
141:codegraph orient --root . --budget small
142:
143:# Follow an anchor returned by either command
144:codegraph explain src/review.ts
145:codegraph deps src/review.ts --json
146:codegraph refs src/review.ts:215:23
147:```
148:
149:### Review local changes
150:
151:```bash
152:# Compact reviewer handoff for staged and unstaged tracked changes
153:codegraph review --base HEAD --head WORKTREE
154:
155:# Broader blast-radius map when the summary needs expansion
156:codegraph impact --base HEAD --head WORKTREE
157:
158:# Deterministic affected-test paths for focused validation
159:codegraph affected --base HEAD --head WORKTREE --quiet
160:```
161:
162:Use `--head STAGED` to compare `HEAD` with the index, or use refs such as `--base origin/main --head HEAD` for a branch review.
163:
164:### Inspect repository health
165:
166:```bash
167:codegraph inspect ./src --limit 20
168:codegraph cycles --sort priority
169:codegraph unresolved
170:codegraph apisurface
171:codegraph duplicates ./src --min-confidence medium --limit 20
172:codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals
173:```
174:
175:### Export the model
176:
177:```bash
178:codegraph graph --root . ./src --json --output codegraph.json
179:codegraph graph --root . ./src --mermaid --output graph.mmd
180:codegraph graph --root . ./src --dot --output graph.dot
181:codegraph graph --root . ./src --sqlite codegraph.sqlite
182:```
183:
184:## Visualize a graph
185:
186:The packaged viewer is a human-facing graph UI; agents should use graph JSON, SQLite, MCP, or `--json` instead. Its command is `codegraph viewer [--root <root>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]`; the root defaults to the current directory.
187:
188:![Codegraph graph viewer with `src/cli.ts` selected and its immediate dependencies labeled](docs/graph-visualization/viewer-selected-node.webp)
189:
190:```bash
191:codegraph viewer --root . --open
192:codegraph viewer --root . --graph codegraph-out/graph.json --open
193:codegraph viewer --root . --port 4173 --print-url
194:```
195:
196:The default host is `127.0.0.1` and the default port is `4173`. Without `--graph`, each UI load or reload builds a current graph projection through the automatically validated `.codegraph-cache` index; `init`, `index`, and an exported JSON file are not prerequisites. An explicit `--graph` serves that root-confined snapshot through the same `/graph.json` route, while `--print-url` only prints the deterministic URL and exits.
197:
198:The UI imports Sigma from `esm.sh`, so it requires network access to that CDN and is not offline or self-contained.
199:
200:## What the output looks like
201:
202:Because ranking and counts change with the working tree, this abbreviated `explore` excerpt shows the stable response structure rather than snapshot-specific totals:
203:
204:```text
205:Anchors
206:- buildReviewReport [symbol] src/review.ts
207:- src/cli/help.ts:1 [chunk] src/cli/help.ts
208:- ReviewPreset [symbol] src/review.ts
209:
210:Relevant source
211:- buildReviewReport is defined in src/review.ts.
212:- References, dependencies, and dependents are summarized here.
213:
214:Blast radius
215:- src/review.ts: src/index.ts, src/cli/review.ts, src/mcp/server.ts, ...
216:
217:Candidate tests
218:- tests/agent-explain.test.ts
219:- tests/agent-explore.test.ts
220:- tests/agent-packet.test.ts
221:
222:Follow-ups
223:- codegraph file src/review.ts
224:- codegraph refs src/review.ts:215:23
225:
226:Limits
227:- anchors, packets, paths, blast radius, reverse dependencies, and candidate tests
228:
229:Recommended next: codegraph file src/review.ts
230:```
231:
232:Real output includes counts, copyable follow-ups, explicit limits, and omission counts. It does not pretend omitted context was analyzed.
233:
234:A worktree review is optimized for a different job:
235:
236:```text
237:Review Summary
238:==============
239:Status: ok
240:Files changed: 5
241:Symbols changed: 22
242:Candidate tests: 1 (high: 1, medium: 0, low: 0)
243:Risk: high (80)
244:Signals: exported-symbols-changed, many-symbols-changed
245:```
246:
247:Structured output carries the underlying changed files, symbols, graph edges, reasons, diagnostics, snippets, and candidate-test confidence instead of requiring a caller to parse this display text.
248:
249:## Why Codegraph
250:
251:### Spend context on the problem, not repository discovery
252:
253:One bounded `explore` response can combine ranked anchors, relevant source, dependency paths, blast radius, candidate tests, and next commands. The agent gets an evidence-backed starting point without first dumping the tree or repeatedly guessing which files to open.
254:
255:### Ground the next action
256:
257:Results carry source paths, symbol ranges, stable handles, rank reasons, graph relationships, confidence, and omission counts. An agent can inspect why something ranked, jump to the definition or references, and continue from an exact target instead of treating a fuzzy match as an answer.
258:
259:### Reuse one map from discovery through review
260:
261:Search, navigation, dependency analysis, impact, and review share the same graph and semantic index. The target found during discovery can flow directly into `explain`, `refs`, `deps`, impact analysis, and candidate-test selection.
262:
263:### Work across the repository an agent actually has
264:
265:Source code, SQL, workspace packages, documentation links, stylesheets, templates, and single-file components can participate in one repository model. Capability claims remain language-specific, so graph support is not presented as full compiler or language-server parity.
266:
267:### Keep the evidence local and reusable
268:
269:Codegraph runs locally through a CLI, library, or MCP server. People can read pretty output; agents and programs can keep structured JSON, stable handles, warm sessions, SQLite data, or graph exports without parsing display text.
270:
271:## Why not just grep or an LSP?
272:
273:Codegraph complements both.
274:
275:- Use text search for exact strings, logs, config keys, and prose.
276:- Use a compiler or language server when you need compiler-grade type analysis, overload resolution, dynamic dispatch, or editor refactors.
277:- Use Codegraph when the question crosses files, languages, dependency edges, a git diff, or an agent context boundary.
278:
279:The useful distinction is evidence shape, not a claim that one tool replaces every other tool.
280:
281:## Agent setup
282:
283:Run `codegraph install` on an interactive terminal to detect supported clients, preview exact Codegraph-owned changes, and confirm once. Use `--all` when you intentionally want the complete current catalog without detection:
284:
285:```bash
286:codegraph install
287:codegraph install --target codex,claude --dry-run
288:codegraph install --target codex,claude --yes
289:codegraph install --all --dry-run
290:codegraph install --all --yes
291:codegraph install --print-config codex
292:```
293:
294:Supported target ids are `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, `kilo`, and `agents` (universal agent skills). OMP uses `.omp/agent/managed-skills/codegraph`; Kilo uses `.kilocode/skills/codegraph` plus its comment-preserving JSONC MCP config. Interactive writes default to no; noninteractive writes require `--yes`, and uninstall removes only Codegraph-owned content. `--all` cannot be combined with target selection, `--detect`, or `--print-config`.
295:
296:For a skill without MCP configuration:
297:
298:```bash
299:codegraph skill install --agent codex
300:codegraph skill install --agent claude
301:codegraph skill install --agent cursor
302:```
…
305:
…
380:Codegraph is MIT licensed.

[Showing lines 1-300 of 381. Use :301 to continue]