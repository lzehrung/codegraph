# C# accuracy oracle

Requires the .NET 10 SDK. From the repository root, invoke the Roslyn oracle with:

```sh
dotnet run --project scripts/accuracy/oracles/csharp -c Release -- --root <dir> --request <req> --output <resp>
```

Restore uses the committed NuGet lock file. Build output remains in this directory's `bin/` and `obj/` directories.

The compilation uses the requested source files and runtime assemblies without restoring the
corpus. When a `.csproj` enables implicit usings, an in-memory generated document supplies the
SDK's standard global usings; it is never sampled or reported as a corpus file.

Run the focused regression with
`CODEGRAPH_ACCURACY_ORACLES=1 npx vitest run tests/accuracy-csharp-oracle.test.ts`.
