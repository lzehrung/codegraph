#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "../dist/indexer.js";
import { supportForFile } from "../dist/languages.js";

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const requestedRoot = rootIndex < 0 ? undefined : args[rootIndex + 1];
const rootDir = path.resolve(requestedRoot ?? defaultRootDir);
const corpusDir = path.join(rootDir, "tests", "edge-corpus");
const json = args.includes("--json");

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

function parseFindings(parsed, file) {
  const findings = [];
  const tree = parsed.tree;
  const columns = tree.columns;
  for (let nodeId = 0; nodeId < columns.nodeCount; nodeId += 1) {
    const kind = columns.kinds[columns.kindIds[nodeId]];
    const isMissing = columns.isMissing[nodeId] !== 0;
    if (kind === "ERROR" || isMissing) {
      const startIndex = tree.stringIndexForByte(columns.startIndex[nodeId]);
      const endIndex = tree.stringIndexForByte(columns.endIndex[nodeId]);
      findings.push({
        kind: isMissing ? "MISSING" : "ERROR",
        file: path.relative(rootDir, file).replaceAll("\\", "/"),
        line: columns.startRow[nodeId] + 1,
        text: parsed.source.slice(startIndex, endIndex).slice(0, 80),
      });
    }
  }
  return findings;
}

try {
  if (rootIndex >= 0 && !requestedRoot) throw new Error("--root requires a directory");
  const languageEntries = (await fs.readdir(corpusDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const report = [];

  for (const language of languageEntries) {
    const files = await supportedFiles(path.join(corpusDir, language.name));
    const findings = [];
    for (const file of files) {
      const parsed = await parseFile(file);
      findings.push(...parseFindings(parsed, file));
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
  process.exitCode = 1;
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);
}
