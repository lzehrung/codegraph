// Child process for the atomic writer tests: writes the JSON document in `<document.json>` to `<destination>` with
// `writeJsonFileInChunks`, the call `graph --json --output <destination>` makes.
// Usage: tsx write-json-to.ts <destination> <document.json>
import fsp from "node:fs/promises";
import { writeJsonFileInChunks } from "../../src/util/json-chunks.js";

const [destination, documentPath] = process.argv.slice(2);
if (!destination || !documentPath) throw new Error("usage: write-json-to.ts <destination> <document.json>");
const document: unknown = JSON.parse(await fsp.readFile(documentPath, "utf8"));
await writeJsonFileInChunks(destination, document);
