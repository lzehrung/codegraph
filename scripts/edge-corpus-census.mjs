#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "../dist/indexer.js";
import { supportForFile } from "../dist/languages.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = path.join(rootDir, "tests", "edge-corpus");
const json = process.argv.slice(2).includes("--json");

async function supportedFiles(directory) {
  const files = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && supportForFile(fullPath)) files.push(fullPath);
    }
  }
  await visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

function parseFindings(root, file) {
  const findings = [];
  function visit(node) {
    if (node.type === "ERROR" || node.isMissing) {
      findings.push({
        kind: node.isMissing ? "MISSING" : "ERROR",
        file: path.relative(rootDir, file).replaceAll("\\", "/"),
        line: node.startPosition.row + 1,
        text: node.text.slice(0, 80),
      });
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(root);
  return findings;
}

try {
  const languageEntries = (await fs.readdir(corpusDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const report = [];

  for (const language of languageEntries) {
    const files = await supportedFiles(path.join(corpusDir, language.name));
    const findings = [];
    for (const file of files) {
      const parsed = await parseFile(file);
      findings.push(...parseFindings(parsed.tree.rootNode, file));
    }
    const filesWithFindings = new Set(findings.map((finding) => finding.file)).size;
    report.push({
      language: language.name,
      files: files.length,
      filesWithErrorOrMissing: filesWithFindings,
      nodeCount: findings.length,
      findings,
    });
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Language       Files  Files w/ ERROR/MISSING  Nodes");
    for (const entry of report) {
      console.log(
        entry.language.padEnd(14) +
          String(entry.files).padStart(5) +
          String(entry.filesWithErrorOrMissing).padStart(23) +
          String(entry.nodeCount).padStart(6),
      );
      for (const finding of entry.findings) {
        console.log("  " + finding.kind + " " + finding.file + ":" + finding.line + " " + JSON.stringify(finding.text));
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);
}
