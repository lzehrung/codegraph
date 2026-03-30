import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "javascript",
  samples: [
    {
      name: "chunks basic JavaScript structures",
      sourceFile: "javascript.sample.js",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "module_var" && c.name === "API_BASE_URL")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "Foo")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "bar")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "baz")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "javascript",
    dependencyGraph: [
      {
        from: "dynamic-import.js",
        to: { type: "file", path: "helpers.js" },
      },
      {
        from: "angularjs/user.service.js",
        to: { type: "external", name: "$http" },
      },
      {
        from: "angularjs/user.controller.js",
        to: { type: "file", path: "angularjs/user.service.js" },
      },
      {
        from: "angularjs/user.controller.js",
        to: { type: "external", name: "$scope" },
      },
      {
        from: "angularjs/user.controller.js",
        to: { type: "external", name: "$state" },
      },
      {
        from: "angularjs/user-card.directive.js",
        to: { type: "file", path: "angularjs/user.controller.js" },
      },
      {
        from: "angularjs/user-card.directive.js",
        to: { type: "file", path: "angularjs/user-card.template.html" },
      },
    ],
  },
};

runLanguageTests(definition);
