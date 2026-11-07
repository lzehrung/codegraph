export const PHP_PATH_MAPPINGS = ["plain", "psr4", "psr0"] as const;
export type PhpPathMapping = (typeof PHP_PATH_MAPPINGS)[number];

export const PHP_PATH_IMPORT_FORMS = [
  { name: "class", role: "class", declaration: "class Gadget {}", use: "function consume() { return new Gadget(); }" },
  {
    name: "interface",
    role: "class",
    declaration: "interface Gadget {}",
    use: "class Consumer implements Gadget {}",
  },
  { name: "trait", role: "class", declaration: "trait Gadget {}", use: "class Consumer { use Gadget; }" },
  {
    name: "enum",
    role: "class",
    declaration: "enum Gadget { case Ready; }",
    use: "function consume(Gadget $value): Gadget { return $value; }",
  },
  {
    name: "function",
    role: "function",
    declaration: "function Gadget() { return 1; }",
    use: "function consume() { return Gadget(); }",
  },
  { name: "const", role: "const", declaration: "const Gadget = 1;", use: "function consume() { return Gadget; }" },
] as const;
export type PhpPathImportForm = (typeof PHP_PATH_IMPORT_FORMS)[number];

/** Path-shaped owners with a namespace decoy; an in-file decoy also exercises qualified cache invalidation. */
export function phpPathFallbackFixture(
  mapping: PhpPathMapping,
  form: PhpPathImportForm = PHP_PATH_IMPORT_FORMS[0],
  withInFileDecoy = false,
) {
  const owner = mapping === "plain" ? "App/Gadget.php" : "src/Gadget.php";
  const importKind = form.role === "class" ? "" : `${form.role} `;
  const lines = ["<?php", "namespace Client;", `use ${importKind}App\\Gadget;`, form.use];
  const ownerSource = [
    "<?php",
    "namespace App {",
    form.declaration,
    "}",
    ...(withInFileDecoy ? ["namespace InFileDecoy {", form.declaration, "}"] : []),
    "",
  ].join("\n");
  const missingSource = [
    "<?php",
    "namespace App {",
    form.declaration.replace("Gadget", "Different"),
    "}",
    ...(withInFileDecoy ? ["namespace InFileDecoy {", form.declaration, "}"] : []),
    "",
  ].join("\n");
  const wrongKind = form.role === "class" ? "function Gadget() { return 1; }" : "class Gadget {}";
  const wrongKindSource = ownerSource.replace(form.declaration, () => wrongKind);
  const files: Record<string, string> = {
    [owner]: ownerSource,
    "Use.php": lines.join("\n"),
    "Decoy.php": ["<?php", "namespace Other;", form.declaration, ""].join("\n"),
  };
  if (mapping !== "plain") {
    files["composer.json"] = JSON.stringify({
      autoload: { [mapping === "psr4" ? "psr-4" : "psr-0"]: { "App\\": "src/" } },
    });
  }
  return { files, owner, ownerSource, missingSource, wrongKindSource, lines, form };
}

export const PHP_INCOMPLETE_DECLARATION_SOURCES = [
  { name: "truncated class", source: "<?php\nnamespace App;\nclass" },
  { name: "syntax error after namespace", source: "<?php\nnamespace App;\n@@@\n" },
  { name: "missing closing brace", source: "<?php\nnamespace App;\nclass Different {" },
  { name: "unread namespace", source: "<?php\nclass" },
] as const;
