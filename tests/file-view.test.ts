import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatAgentFileViewResponse,
  getCodegraphFileView,
  getCodegraphFileViewWithSession,
} from "../src/agent/fileView.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

const tempPaths = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.add(tempDir);
  return tempDir;
}

async function writeFile(root: string, relativePath: string, contents: string | Buffer): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

afterEach(async () => {
  await Promise.all(Array.from(tempPaths, async (tempPath) => await fs.rm(tempPath, { recursive: true, force: true })));
  tempPaths.clear();
});

describe("agent file view", () => {
  it("numbers the requested line range while retaining the full-file line count and final empty line", async () => {
    const root = await makeTempDir("cg-file-view-lines-");
    await writeFile(root, "notes.txt", "alpha\nbeta\ngamma\n");

    const middle = await getCodegraphFileView({ root, file: "notes.txt", offset: 2, limit: 2, maxBytes: 100 });

    expect(middle).toMatchObject({
      file: "notes.txt",
      offset: 2,
      limit: 2,
      totalLines: 4,
      content: "2\tbeta\n3\tgamma",
      lineFormat: "number-tab-line",
      text: "beta\ngamma",
      truncated: false,
      page: { nextOffset: 4 },
    });

    const finalEmptyLine = await getCodegraphFileView({
      root,
      file: "notes.txt",
      offset: 4,
      limit: 2,
      maxBytes: 100,
    });

    expect(finalEmptyLine).toMatchObject({
      offset: 4,
      totalLines: 4,
      content: "4\t",
      text: "",
      truncated: false,
    });
    expect(finalEmptyLine.page).toBeUndefined();
  });

  it("continues at the next whole line after byte truncation and reads beyond the first byte window", async () => {
    const root = await makeTempDir("cg-file-view-pages-");
    await writeFile(root, "paged notes.txt", "alphabet\nsecond\nthird");

    const firstPage = await getCodegraphFileView({
      root,
      file: "paged notes.txt",
      offset: 1,
      limit: 2,
      maxBytes: 3,
    });

    expect(firstPage).toMatchObject({
      totalLines: 3,
      content: "1\talp",
      text: "alp",
      truncated: true,
      page: { nextOffset: 2 },
    });
    expect(formatAgentFileViewResponse(firstPage)).toBe(
      [
        "File: paged notes.txt",
        "Lines 1-1 of 3",
        "1\talp",
        "Content was truncated by the 500000-byte hard limit or a smaller requested maxBytes.",
        "Next page: codegraph file 'paged notes.txt' --offset 2 --limit 2 --pretty",
      ].join("\n"),
    );

    const nextPage = await getCodegraphFileView({
      root,
      file: "paged notes.txt",
      offset: 2,
      limit: 2,
      maxBytes: 12,
    });

    expect(nextPage).toMatchObject({
      offset: 2,
      totalLines: 3,
      content: "2\tsecond\n3\tthird",
      text: "second\nthird",
      truncated: false,
    });
    expect(nextPage.page).toBeUndefined();
  });

  it("rejects lexical and symlink escapes after resolving real paths", async () => {
    const root = await makeTempDir("cg-file-view-root-");
    const outside = await makeTempDir("cg-file-view-outside-");
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "outside\n", "utf8");

    await expect(getCodegraphFileView({ root, file: outsideFile, limit: 1, maxBytes: 100 })).rejects.toThrow(
      /File is outside project root:/,
    );

    const linkedFile = path.join(root, "linked-secret.txt");
    try {
      await fs.symlink(outsideFile, linkedFile, "file");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    await expect(getCodegraphFileView({ root, file: "linked-secret.txt", limit: 1, maxBytes: 100 })).rejects.toThrow(
      /File is outside project root:/,
    );
  });

  it("redacts a sensitive in-root symlink target even when the requested filename is benign", async () => {
    const root = await makeTempDir("cg-file-view-sensitive-symlink-");
    const targetFile = path.join(root, ".env");
    const linkedFile = path.join(root, "project-notes.txt");
    const secretValue = "symlink-target-secret";
    await fs.writeFile(targetFile, `API_TOKEN=${secretValue}\n`, "utf8");

    try {
      await fs.symlink(targetFile, linkedFile, "file");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const redacted = await getCodegraphFileView({ root, file: "project-notes.txt", limit: 10, maxBytes: 100 });

    expect(redacted).toMatchObject({
      file: "project-notes.txt",
      totalLines: 2,
      text: "Sensitive environment values omitted.\nKeys: API_TOKEN",
      content: "1\tSensitive environment values omitted.\n2\tKeys: API_TOKEN",
      sensitive: { kind: "environment", redacted: true, allowSensitiveRequired: true },
    });
    expect(JSON.stringify(redacted)).not.toContain(secretValue);
  });

  it("keeps graph context opt-in and reports only the target's direct importer", async () => {
    const root = await makeTempDir("cg-file-view-graph-");
    await writeFile(root, "src/auth.ts", "export function validateUser() { return true; }\n");
    await writeFile(
      root,
      "src/server.ts",
      "import { validateUser } from './auth';\nexport const allowed = validateUser();\n",
    );
    await writeFile(root, "src/api.ts", "import { allowed } from './server';\nexport const response = allowed;\n");

    const plain = await getCodegraphFileView({ root, file: "src/auth.ts", limit: 1, maxBytes: 100 });
    expect(plain.content).toBe("1\texport function validateUser() { return true; }");
    expect(plain.graphContext).toBeUndefined();

    const contextual = await getCodegraphFileView({
      root,
      file: "src/auth.ts",
      limit: 1,
      maxBytes: 100,
      includeGraphContext: true,
    });

    expect(contextual.graphContext?.usedBy).toEqual(["src/server.ts"]);
    expect(contextual.graphContext?.symbols).toContainEqual({ name: "validateUser", kind: "function", line: 1 });
  });

  it("does not perform freshness or project-index work for a plain session read", async () => {
    const root = await makeTempDir("cg-file-view-index-free-");
    await writeFile(root, "plain.txt", "live bytes\n");
    const forbiddenSessionWork = async (): Promise<never> => {
      throw new Error("plain file reads must not touch the project session");
    };
    const session: AgentSession = {
      root,
      checkFreshness: forbiddenSessionWork,
      loadProject: forbiddenSessionWork,
      invalidate: () => undefined,
    };

    const response = await getCodegraphFileViewWithSession(session, {
      root,
      file: "plain.txt",
      limit: 1,
      maxBytes: 100,
    });

    expect(response.content).toBe("1\tlive bytes");
    expect(response.graphContext).toBeUndefined();
  });

  it("returns current disk bytes even when the supplied session snapshot is stale", async () => {
    const root = await makeTempDir("cg-file-view-stale-");
    await writeFile(root, "state.ts", "export const state = 'old';\n");
    const session = createAgentSession({ root });
    await session.loadProject({ symbolGraph: "skip" });
    await writeFile(root, "state.ts", "export const state = 'live';\n");

    const response = await getCodegraphFileViewWithSession(session, {
      root,
      file: "state.ts",
      limit: 1,
      maxBytes: 100,
    });

    expect(response.content).toBe("1\texport const state = 'live';");
    expect(response.text).toBe("export const state = 'live';");
  });

  it("rejects NUL-bearing content even when its extension looks textual", async () => {
    const root = await makeTempDir("cg-file-view-binary-");
    await writeFile(root, "payload.txt", Buffer.from([0x61, 0x62, 0x00, 0x63]));

    await expect(getCodegraphFileView({ root, file: "payload.txt", limit: 10, maxBytes: 100 })).rejects.toThrow(
      /Binary files are not supported:/,
    );
  });

  it("rejects malformed UTF-8 on an unselected later line outside the returned byte window", async () => {
    const root = await makeTempDir("cg-file-view-invalid-later-utf8-");
    await writeFile(
      root,
      "later-line.txt",
      Buffer.concat([Buffer.from("selected\nvalid but unselected\n", "utf8"), Buffer.from([0xff]), Buffer.from("\n")]),
    );

    await expect(
      getCodegraphFileView({ root, file: "later-line.txt", offset: 1, limit: 1, maxBytes: 4 }),
    ).rejects.toThrow(/Binary or non-UTF-8 files are not supported:/);
  });

  it("rejects an invalid UTF-8 continuation crossing the 64 KiB read boundary outside the selected page", async () => {
    const root = await makeTempDir("cg-file-view-invalid-boundary-utf8-");
    const selectedLine = Buffer.from("selected\n", "utf8");
    const readBufferBytes = 64 * 1024;
    const padding = Buffer.alloc(readBufferBytes - selectedLine.length - 1, 0x61);
    await writeFile(root, "boundary.txt", Buffer.concat([selectedLine, padding, Buffer.from([0xc3, 0x28])]));

    await expect(
      getCodegraphFileView({ root, file: "boundary.txt", offset: 1, limit: 1, maxBytes: 8 }),
    ).rejects.toThrow(/Binary or non-UTF-8 files are not supported:/);
  });

  it.each([
    { name: "invalid continuation", file: "invalid-continuation.ts", bytes: [0xc3, 0x28] },
    { name: "incomplete final sequence", file: "incomplete-sequence.md", bytes: [0xe2, 0x82] },
  ])("rejects $name bytes in text-looking files", async ({ file, bytes }) => {
    const root = await makeTempDir("cg-file-view-invalid-utf8-");
    await writeFile(root, file, Buffer.concat([Buffer.from("valid prefix\n", "utf8"), Buffer.from(bytes)]));

    await expect(getCodegraphFileView({ root, file, limit: 10, maxBytes: 100 })).rejects.toThrow(
      /Binary or non-UTF-8 files are not supported:/,
    );
  });

  it.each([
    {
      name: "NUL in an environment file",
      file: ".env",
      invalidBytes: [0x00],
      expectedError: /Binary files are not supported:/,
    },
    {
      name: "malformed UTF-8 in a credential config",
      file: "credentials.json",
      invalidBytes: [0xff],
      expectedError: /Binary or non-UTF-8 files are not supported:/,
    },
    {
      name: "incomplete trailing UTF-8 in an environment file",
      file: ".env.production",
      invalidBytes: [0xe2, 0x82],
      expectedError: /Binary or non-UTF-8 files are not supported:/,
    },
  ])("rejects $name beyond the bounded sensitive-summary prefix", async ({ file, invalidBytes, expectedError }) => {
    const root = await makeTempDir("cg-file-view-sensitive-invalid-");
    const structuralScanBytes = 64 * 1024;
    const keyAndValue = Buffer.from("API_TOKEN=summary-prefix-secret\n", "utf8");
    const padding = Buffer.alloc(structuralScanBytes - keyAndValue.length, 0x61);
    await writeFile(root, file, Buffer.concat([keyAndValue, padding, Buffer.from(invalidBytes)]));

    await expect(getCodegraphFileView({ root, file, offset: 1, limit: 1, maxBytes: 16 })).rejects.toThrow(
      expectedError,
    );
  });

  const sensitiveConfigFixtures = [
    {
      file: ".npmrc",
      kind: "authentication-config",
      raw: "_authToken=npm-token-value\n",
      expectedKeys: "_authToken",
      secretValues: ["npm-token-value"],
    },
    {
      file: ".pypirc",
      kind: "authentication-config",
      raw: "[pypi]\nusername=release-user\npassword=pypi-password-value\n",
      expectedKeys: "password, username",
      secretValues: ["release-user", "pypi-password-value"],
    },
    {
      file: ".netrc",
      kind: "authentication-config",
      raw: "machine registry.example.test login ci-user password netrc-password-value\n",
      expectedKeys: "login, machine, password",
      secretValues: ["registry.example.test", "ci-user", "netrc-password-value"],
    },
    {
      file: "credentials.json",
      kind: "credential-config",
      raw: '{\n  "client_id": "build-client",\n  "client_secret": "json-secret-value"\n}\n',
      expectedKeys: "client_id, client_secret",
      secretValues: ["build-client", "json-secret-value"],
    },
    {
      file: "secrets.production.yaml",
      kind: "credential-config",
      raw: "account: deploy-user\npassword: yaml-secret-value\n",
      expectedKeys: "account, password",
      secretValues: ["deploy-user", "yaml-secret-value"],
    },
    {
      file: "service-account.toml",
      kind: "credential-config",
      raw: 'project_id = "service-project"\nprivate_key = "toml-secret-value"\n',
      expectedKeys: "private_key, project_id",
      secretValues: ["service-project", "toml-secret-value"],
    },
    {
      file: "credential.ini",
      kind: "credential-config",
      raw: "[default]\naccess_key=ini-access-value\nsecret_key=ini-secret-value\n",
      expectedKeys: "access_key, secret_key",
      secretValues: ["ini-access-value", "ini-secret-value"],
    },
  ] as const;

  it.each(sensitiveConfigFixtures)(
    "redacts $kind values in $file by default and returns exact raw text only when allowed",
    async ({ file, kind, raw, expectedKeys, secretValues }) => {
      const root = await makeTempDir("cg-file-view-sensitive-config-");
      await writeFile(root, file, raw);

      const redacted = await getCodegraphFileView({ root, file, limit: 20, maxBytes: 1024 });
      const expectedSummary = `Sensitive ${kind} values omitted.\nKeys: ${expectedKeys}`;

      expect(redacted).toMatchObject({
        file,
        totalLines: 2,
        text: expectedSummary,
        content: `1\tSensitive ${kind} values omitted.\n2\tKeys: ${expectedKeys}`,
        sensitive: { kind, redacted: true, allowSensitiveRequired: true },
      });
      for (const secretValue of secretValues) {
        expect(JSON.stringify(redacted)).not.toContain(secretValue);
      }

      const allowed = await getCodegraphFileView({
        root,
        file,
        limit: 20,
        maxBytes: 1024,
        allowSensitive: true,
      });

      expect(allowed.text).toBe(raw);
      expect(allowed).toMatchObject({
        file,
        sensitive: { kind, redacted: false, allowSensitiveRequired: true },
      });
    },
  );

  const keyBundleFixtures = [
    { file: "client-identity.p12", marker: "p12-private-key-secret" },
    { file: "client-identity.pfx", marker: "pfx-private-key-secret" },
  ] as const;

  it.each(keyBundleFixtures)(
    "redacts valid UTF-8 $file metadata and rejects raw access by binary extension",
    async ({ file, marker }) => {
      const root = await makeTempDir("cg-file-view-key-bundle-");
      const payload = `${marker}\notherwise ordinary text\n`;
      await writeFile(root, file, payload);

      const redacted = await getCodegraphFileView({ root, file, limit: 10, maxBytes: 100 });

      expect(redacted).toMatchObject({
        file,
        totalLines: 2,
        text: `Sensitive key material omitted.\nSize: ${Buffer.byteLength(payload)} bytes.`,
        content: `1\tSensitive key material omitted.\n2\tSize: ${Buffer.byteLength(payload)} bytes.`,
        sensitive: { kind: "key-material", redacted: true, allowSensitiveRequired: true },
      });
      expect(JSON.stringify(redacted)).not.toContain(marker);

      await expect(
        getCodegraphFileView({ root, file, limit: 10, maxBytes: 100, allowSensitive: true }),
      ).rejects.toThrow(/Binary files are not supported:/);
    },
  );

  it("returns key-material metadata without opening target bytes and opens the ordinary raw path only when allowed", async () => {
    const root = await makeTempDir("cg-file-view-key-metadata-only-");
    const keyFiles = [
      { file: "signing.key", marker: "key-private-marker" },
      { file: "certificate.pem", marker: "pem-private-marker" },
      { file: "id_ed25519", marker: "ssh-private-marker" },
      ...keyBundleFixtures,
    ];
    for (const { file, marker } of keyFiles) {
      await writeFile(root, file, `${marker}\n`);
    }
    const openSpy = vi.spyOn(fs, "open");
    const readFileSpy = vi.spyOn(fs, "readFile");

    try {
      for (const { file, marker } of keyFiles) {
        const redacted = await getCodegraphFileView({ root, file, limit: 10, maxBytes: 100 });
        expect(redacted).toMatchObject({
          file,
          text: `Sensitive key material omitted.\nSize: ${Buffer.byteLength(`${marker}\n`)} bytes.`,
          sensitive: { kind: "key-material", redacted: true, allowSensitiveRequired: true },
        });
        expect(JSON.stringify(redacted)).not.toContain(marker);
      }
      expect(openSpy).not.toHaveBeenCalled();
      expect(readFileSpy).not.toHaveBeenCalled();

      const allowed = await getCodegraphFileView({
        root,
        file: keyFiles[0]!.file,
        limit: 10,
        maxBytes: 100,
        allowSensitive: true,
      });

      expect(allowed).toMatchObject({
        file: "signing.key",
        text: "key-private-marker\n",
        content: "1\tkey-private-marker\n2\t",
        sensitive: { kind: "key-material", redacted: false, allowSensitiveRequired: true },
      });
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(path.join(root, "signing.key"), "r");
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it("rejects a directory whose name has a key-material suffix", async () => {
    const root = await makeTempDir("cg-file-view-key-directory-");
    await fs.mkdir(path.join(root, "identity.pem"));

    await expect(getCodegraphFileView({ root, file: "identity.pem", limit: 10, maxBytes: 100 })).rejects.toThrow(
      /File view target is not a file:/,
    );
  });

  it("returns metadata for a NUL-bearing .key file but validates and rejects explicit raw access", async () => {
    const root = await makeTempDir("cg-file-view-key-file-");
    const file = "signing.key";
    const marker = "private-key-secret";
    const payload = Buffer.concat([Buffer.from(marker, "utf8"), Buffer.from([0x00, 0xff])]);
    await writeFile(root, file, payload);

    const redacted = await getCodegraphFileView({ root, file, limit: 10, maxBytes: 100 });

    expect(redacted).toMatchObject({
      file,
      totalLines: 2,
      text: `Sensitive key material omitted.\nSize: ${payload.length} bytes.`,
      content: `1\tSensitive key material omitted.\n2\tSize: ${payload.length} bytes.`,
      sensitive: { kind: "key-material", redacted: true, allowSensitiveRequired: true },
    });
    expect(JSON.stringify(redacted)).not.toContain(marker);

    await expect(getCodegraphFileView({ root, file, limit: 10, maxBytes: 100, allowSensitive: true })).rejects.toThrow(
      /Binary files are not supported:/,
    );
  });

  it("redacts sensitive values into a key-only summary unless raw access is explicit", async () => {
    const root = await makeTempDir("cg-file-view-sensitive-");
    await writeFile(root, ".env", "API_TOKEN=super-secret\nUSER=alice\n");

    const redacted = await getCodegraphFileView({ root, file: ".env", limit: 10, maxBytes: 100 });

    expect(redacted).toMatchObject({
      file: ".env",
      totalLines: 2,
      text: "Sensitive environment values omitted.\nKeys: API_TOKEN, USER",
      content: "1\tSensitive environment values omitted.\n2\tKeys: API_TOKEN, USER",
      sensitive: { kind: "environment", redacted: true, allowSensitiveRequired: true },
    });

    const allowed = await getCodegraphFileView({
      root,
      file: ".env",
      limit: 10,
      maxBytes: 100,
      allowSensitive: true,
    });

    expect(allowed).toMatchObject({
      totalLines: 3,
      text: "API_TOKEN=super-secret\nUSER=alice\n",
      content: "1\tAPI_TOKEN=super-secret\n2\tUSER=alice\n3\t",
      sensitive: { kind: "environment", redacted: false, allowSensitiveRequired: true },
    });
  });
});
