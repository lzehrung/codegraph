export const CSHARP_ALIAS_CALL_SPELLINGS = ["b", "@class", "@this"] as const;

export function csharpAliasCallFixture(alias: string) {
  const lines = [
    `using ${alias} = N.Target;`,
    "public class Use {",
    `  public void Visible() { ${alias}.Run(); }`,
    `  public void Parameter(Decoy.Target ${alias}) { ${alias}.Run(); }`,
    `  public void Local() { var ${alias} = new Decoy.Target(); ${alias}.Run(); }`,
    "  public void Restored() {",
    `    { var ${alias} = new Decoy.Target(); ${alias}.Run(); }`,
    `    ${alias}.Run();`,
    "  }",
    "}",
    "",
  ];
  return {
    files: {
      "Target.cs": "namespace N; public class Target { public static void Run() {} }\n",
      "Decoy.cs": "namespace Decoy; public class Target { public void Run() {} }\n",
      "Use.cs": lines.join("\n"),
    },
    lines,
    sites: [
      { line: 3, caller: "Visible", target: "Target.cs" },
      { line: 4, caller: "Parameter", target: "Decoy.cs" },
      { line: 5, caller: "Local", target: "Decoy.cs" },
      { line: 7, caller: "Restored", target: "Decoy.cs" },
      { line: 8, caller: "Restored", target: "Target.cs" },
    ] as const,
  };
}

export function csharpUnknownAliasReceiverFixture(alias: string) {
  const fixture = csharpAliasCallFixture(alias);
  const lines = [
    `using ${alias} = N.Target;`,
    "public class Use {",
    `  public void Parameter(dynamic ${alias}) { ${alias}.Run(); }`,
    `  public void Local(dynamic value) { dynamic ${alias} = value; ${alias}.Run(); }`,
    `  public void Visible() { ${alias}.Run(); }`,
    "}",
    "",
  ];
  return { files: { ...fixture.files, "Use.cs": lines.join("\n") }, lines };
}
