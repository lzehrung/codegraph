import fs from "node:fs";
import path from "node:path";

export const CHANGELOG_SECTIONS = Object.freeze([
  "Breaking",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);
export const CHANGELOG_FRAGMENT_DIRECTORY = "changes/unreleased";

export function unreleasedSection(changelog) {
  const heading = "## [Unreleased]\n";
  const start = changelog.indexOf(heading);
  if (start < 0 || changelog.indexOf(heading, start + heading.length) >= 0) {
    throw new Error("CHANGELOG.md must have exactly one Unreleased section.");
  }
  const contentStart = start + heading.length;
  const end = changelog.indexOf("\n## [", contentStart);
  if (end < 0) throw new Error("CHANGELOG.md is missing a released version section.");
  if (changelog.slice(contentStart, end).trim()) {
    throw new Error("Do not edit the Unreleased section; add a changes/unreleased/<slug>.md fragment instead.");
  }
  return { start, end };
}

export function parseChangelogFragment(name, source) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) {
    throw new Error(`Invalid changelog fragment name: ${name}; expected <slug>.md using [a-z0-9]+(-[a-z0-9]+)*.`);
  }
  const match = /^---\nsection: ([A-Za-z]+)\n---\n\n([\s\S]+?)\n?$/.exec(source.replaceAll("\r\n", "\n"));
  if (!match || !CHANGELOG_SECTIONS.includes(match[1])) {
    throw new Error(`${name}: expected front matter with section: ${CHANGELOG_SECTIONS.join("|")}.`);
  }
  const text = match[2].trim();
  const containsMarkdownStructure = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|---\s*$|\[[^\]]+\]:)/m.test(text);
  if (!text || containsMarkdownStructure || /\n\s*\n/.test(text)) {
    throw new Error(`${name}: expected one nonempty entry paragraph, without a heading or list marker.`);
  }
  return { name, section: match[1], text: text.replace(/\s*\n\s*/g, " ") };
}

export function readChangelogFragments(rootDir) {
  const directory = path.join(rootDir, CHANGELOG_FRAGMENT_DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      const ignoredDotfile = entry.name.startsWith(".") && !/\.(?:md|txt)$/i.test(entry.name);
      return !ignoredDotfile;
    })
    .sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)))
    .map((entry) => {
      if (!entry.isFile()) throw new Error(`Changelog fragment must be a regular file: ${entry.name}`);
      return parseChangelogFragment(entry.name, fs.readFileSync(path.join(directory, entry.name), "utf8"));
    });
}

export function renderChangelogFragments(fragments) {
  const ordered = [...fragments].sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)));
  const sections = [];
  for (const section of CHANGELOG_SECTIONS) {
    const entries = ordered.filter((fragment) => fragment.section === section);
    if (entries.length) sections.push(`### ${section}\n\n${entries.map((entry) => `- ${entry.text}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
