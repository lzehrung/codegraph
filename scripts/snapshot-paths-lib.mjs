const asciiText = (text) =>
  text.replace(/[^\x20-\x7e]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);

/** Match a whole absolute path prefix, not a suffix inside a project-relative path such as lib/src. */
export function absoluteSnapshotPathPatterns(directories) {
  const forms = new Set();
  for (const directory of directories) {
    for (const spelling of [directory, directory.normalize("NFC")]) {
      forms.add(asciiText(spelling));
      forms.add(asciiText(spelling.replaceAll("\\", "/")));
    }
  }
  return [...forms].map((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s"'=([{>:])${escaped}(?=$|[\\\\/\\s"'\\x60:),\\]}>])`, "i");
  });
}
