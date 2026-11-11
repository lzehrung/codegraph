using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

return await Oracle.RunAsync(args);

internal static class Oracle
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private static readonly string[] ImplicitUsings =
    [
        "System",
        "System.IO",
        "System.Linq",
        "System.Collections.Generic",
        "System.Net.Http",
        "System.Threading",
        "System.Threading.Tasks",
    ];

    public static async Task<int> RunAsync(string[] args)
    {
        try
        {
            var arguments = ParseArguments(args);
            var root = Path.GetFullPath(arguments["--root"]);
            var requestText = await File.ReadAllTextAsync(arguments["--request"], Encoding.UTF8);
            var request = JsonSerializer.Deserialize<OracleRequest>(requestText, JsonOptions)
                ?? throw new InvalidDataException("The request is empty.");
            if (request.SchemaVersion != 1 || request.Language != "csharp")
                throw new InvalidDataException("Expected schemaVersion 1 and language csharp.");
            if (request.Files is null || request.MaxSites < 0 || request.MaxDeclarations < 0)
                throw new InvalidDataException("Files and nonnegative sample sizes are required.");

            var response = await AnalyzeAsync(root, request);
            await File.WriteAllTextAsync(arguments["--output"], JsonSerializer.Serialize(response, JsonOptions), new UTF8Encoding(false));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArguments(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Length; i += 2)
        {
            if (i + 1 >= args.Length || args[i] is not ("--root" or "--request" or "--output"))
                throw new ArgumentException("Expected --root <dir> --request <file> --output <file>.");
            if (!result.TryAdd(args[i], args[i + 1]))
                throw new ArgumentException($"Repeated argument: {args[i]}");
        }
        if (!result.ContainsKey("--root") || !result.ContainsKey("--request") || !result.ContainsKey("--output"))
            throw new ArgumentException("Expected --root <dir> --request <file> --output <file>.");
        return result;
    }

    private static async Task<OracleResponse> AnalyzeAsync(string root, OracleRequest request)
    {
        var errors = new List<string>();
        var compilationOptions = new CSharpCompilationOptions(
            OutputKind.DynamicallyLinkedLibrary,
            nullableContextOptions: NullableContextOptions.Enable);
        var addImplicitUsings = HasImplicitUsings(root, errors);

        using var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId();
        var projectInfo = ProjectInfo.Create(
            projectId,
            VersionStamp.Create(),
            "AccuracyCorpus",
            "AccuracyCorpus",
            LanguageNames.CSharp,
            parseOptions: new CSharpParseOptions(LanguageVersion.Latest),
            compilationOptions: compilationOptions,
            metadataReferences: RuntimeReferences());
        var solution = workspace.CurrentSolution.AddProject(projectInfo);
        if (addImplicitUsings)
        {
            // Regular compilations do not apply CSharpCompilationOptions.Usings. The SDK also
            // supplies implicit global usings in a generated source, never a corpus file.
            var globalUsings = string.Join("\n", ImplicitUsings.Select(name => $"global using {name};"));
            solution = solution.AddDocument(DocumentId.CreateNewId(projectId), "ImplicitUsings.g.cs", SourceText.From(globalUsings, Encoding.UTF8));
        }
        var paths = new Dictionary<string, string>(PathComparer());
        var documentIds = new List<DocumentId>();
        foreach (var relative in request.Files.OrderBy(path => path, StringComparer.Ordinal))
        {
            var fullPath = ResolveSourcePath(root, relative);
            if (!paths.TryAdd(fullPath, relative))
                throw new InvalidDataException($"Duplicate source file: {relative}");
            var text = await File.ReadAllTextAsync(fullPath, Encoding.UTF8);
            var documentId = DocumentId.CreateNewId(projectId);
            solution = solution.AddDocument(documentId, Path.GetFileName(fullPath), SourceText.From(text, Encoding.UTF8), filePath: fullPath);
            documentIds.Add(documentId);
        }
        if (!workspace.TryApplyChanges(solution))
            throw new InvalidOperationException("Could not create the Roslyn workspace.");
        solution = workspace.CurrentSolution;

        var sites = new List<SiteCandidate>();
        var declarations = new List<DeclarationCandidate>();
        var sources = new Dictionary<SyntaxTree, SourceDocument>();
        foreach (var id in documentIds)
        {
            var document = solution.GetDocument(id) ?? throw new InvalidOperationException("Missing source document.");
            var syntaxRoot = await document.GetSyntaxRootAsync() ?? throw new InvalidOperationException("Missing syntax tree.");
            var source = new SourceDocument(document, paths[document.FilePath!]);
            sources.Add(syntaxRoot.SyntaxTree, source);
            foreach (var node in syntaxRoot.DescendantNodes())
            {
                if (node is SimpleNameSyntax simpleName && IsIdentifierUse(simpleName))
                    sites.Add(new SiteCandidate(source, simpleName, Position(simpleName.Identifier.GetLocation(), source.Path)));
                if (TryDeclaration(node, out var token, out var kind))
                    declarations.Add(new DeclarationCandidate(source, node, token, kind, Position(token.GetLocation(), source.Path)));
            }
        }

        SortAndShuffle(sites, candidate => candidate.Position, request.Seed);
        SortAndShuffle(declarations, candidate => candidate.Position, request.Seed);
        var models = new Dictionary<DocumentId, SemanticModel>();
        async Task<SemanticModel> ModelAsync(SourceDocument source)
        {
            if (!models.TryGetValue(source.Document.Id, out var model))
            {
                model = await source.Document.GetSemanticModelAsync() ?? throw new InvalidOperationException("Missing semantic model.");
                models.Add(source.Document.Id, model);
            }
            return model;
        }

        var siteResults = new List<OracleSite>();
        foreach (var candidate in sites.Take(request.MaxSites))
        {
            var model = await ModelAsync(candidate.Source);
            var constructor = ConstructorAt(candidate.Node);
            var symbolInfo = model.GetSymbolInfo(candidate.Node);
            var symbol = SingleSymbol(symbolInfo);
            var form = SiteForm(candidate.Node, symbol, constructor);
            if (constructor is not null)
            {
                var constructorInfo = model.GetSymbolInfo(constructor);
                var constructorSymbol = SingleSymbol(constructorInfo);
                if (constructorInfo.Symbol is null && constructorInfo.CandidateSymbols.Length > 1)
                    symbol = null;
                else if (constructorSymbol is not null && !constructorSymbol.IsImplicitlyDeclared && HasProjectLocation(constructorSymbol, sources))
                    symbol = constructorSymbol;
            }
            var (definitions, external) = SymbolLocations(symbol, sources);
            siteResults.Add(new OracleSite(candidate.Position.File, candidate.Position.Line, candidate.Position.Column,
                candidate.Node.Identifier.ValueText, form, definitions, external));
        }

        var declarationResults = new List<OracleDeclaration>();
        foreach (var candidate in declarations.Take(request.MaxDeclarations))
        {
            var model = await ModelAsync(candidate.Source);
            var symbol = model.GetDeclaredSymbol(candidate.Node);
            if (symbol is null)
            {
                errors.Add($"Could not resolve declaration {candidate.Position.File}:{candidate.Position.Line}:{candidate.Position.Column}.");
                continue;
            }
            var references = await FindReferencesAsync(symbol, solution, sources);
            var relatedDeclarations = RelatedDeclarations(symbol, candidate.Position, sources);
            declarationResults.Add(new OracleDeclaration(candidate.Position.File, candidate.Position.Line, candidate.Position.Column,
                candidate.Token.ValueText, candidate.Kind, references, relatedDeclarations));
        }

        var version = typeof(CSharpCompilation).Assembly.GetName().Version?.ToString(3) ?? "unknown";
        var unresolved = siteResults.Count(site => site.Definitions.Count == 0 && !site.External);
        return new OracleResponse(1, "csharp", new OracleIdentity("roslyn", version), siteResults, declarationResults,
            new OracleDiagnostics(documentIds.Count, unresolved, errors));
    }

    private static StringComparer PathComparer() => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private static string ResolveSourcePath(string root, string relative)
    {
        if (string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.Contains('\\'))
            throw new InvalidDataException($"Expected a relative POSIX source path: {relative}");
        var fullPath = Path.GetFullPath(Path.Combine(root, relative));
        var prefix = Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(prefix, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new InvalidDataException($"Source file is outside the root: {relative}");
        return fullPath;
    }

    private static bool HasImplicitUsings(string root, List<string> errors)
    {
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var file in Directory.EnumerateFiles(root, "*.csproj", options))
        {
            try
            {
                var document = XDocument.Load(file);
                foreach (var element in document.Descendants().Where(element => element.Name.LocalName == "ImplicitUsings"))
                {
                    var value = element.Value.Trim();
                    if (value.Equals("enable", StringComparison.OrdinalIgnoreCase) || value.Equals("true", StringComparison.OrdinalIgnoreCase))
                        return true;
                }
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Xml.XmlException)
            {
                errors.Add($"Could not read {Path.GetRelativePath(root, file).Replace('\\', '/')}: {error.Message}");
            }
        }
        return false;
    }

    private static IEnumerable<MetadataReference> RuntimeReferences()
    {
        var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            ?? throw new InvalidOperationException("The runtime did not provide trusted platform assemblies.");
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)
            ?? throw new InvalidOperationException("Could not locate the runtime assemblies.");
        foreach (var path in trusted.Split(Path.PathSeparator))
        {
            if (!PathComparer().Equals(Path.GetDirectoryName(path), runtimeDirectory))
                continue;
            var name = Path.GetFileName(path);
            if (name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)
                || name.Equals("netstandard.dll", StringComparison.OrdinalIgnoreCase)
                || name.Equals("mscorlib.dll", StringComparison.OrdinalIgnoreCase))
                yield return MetadataReference.CreateFromFile(path);
        }
    }

    private static bool IsIdentifierUse(SimpleNameSyntax name)
    {
        if (name.Identifier.IsMissing)
            return false;
        if (name.Parent is NameEqualsSyntax equals && equals.Parent is UsingDirectiveSyntax)
            return false;
        if (name.Parent is AliasQualifiedNameSyntax alias && alias.Alias == name && name.Identifier.ValueText == "global")
            return false;
        SyntaxNode outer = name;
        while (outer.Parent is NameSyntax)
            outer = outer.Parent;
        if (outer.Parent is BaseNamespaceDeclarationSyntax namespaceDeclaration && namespaceDeclaration.Name == outer)
            return false;
        if (name is IdentifierNameSyntax identifier && identifier.IsVar && name.Parent is VariableDeclarationSyntax variable && variable.Type == name)
            return false;
        return true;
    }

    private static ObjectCreationExpressionSyntax? ConstructorAt(SimpleNameSyntax name)
    {
        SyntaxNode outer = name;
        while (outer.Parent is QualifiedNameSyntax or AliasQualifiedNameSyntax)
            outer = outer.Parent;
        if (outer.Parent is not ObjectCreationExpressionSyntax creation || creation.Type != outer)
            return null;
        return RightmostName(creation.Type) == name ? creation : null;
    }

    private static SimpleNameSyntax? RightmostName(TypeSyntax type) => type switch
    {
        SimpleNameSyntax simple => simple,
        QualifiedNameSyntax qualified => qualified.Right,
        AliasQualifiedNameSyntax alias => alias.Name,
        _ => null,
    };

    private static string SiteForm(SimpleNameSyntax name, ISymbol? symbol, ObjectCreationExpressionSyntax? constructor)
    {
        if (name.Ancestors().OfType<UsingDirectiveSyntax>().Any())
            return "import";
        if (constructor is not null)
            return "constructor";
        if (name.Parent is InvocationExpressionSyntax invocation && invocation.Expression == name)
            return "bare-call";
        if (name.Parent is MemberAccessExpressionSyntax access && access.Name == name)
        {
            if (access.Parent is InvocationExpressionSyntax memberCall && memberCall.Expression == access)
                return "member-call";
            return "member-access";
        }
        if (name.Parent is MemberBindingExpressionSyntax binding && binding.Name == name)
        {
            if (binding.Parent is InvocationExpressionSyntax conditionalCall && conditionalCall.Expression == binding)
                return "member-call";
            return "member-access";
        }
        if (symbol is ITypeSymbol || symbol is IAliasSymbol { Target: ITypeSymbol } || IsTypeContext(name))
            return "type-reference";
        return "other-identifier";
    }

    private static bool IsTypeContext(SimpleNameSyntax name)
    {
        SyntaxNode outer = name;
        while (outer.Parent is QualifiedNameSyntax or AliasQualifiedNameSyntax or NullableTypeSyntax or ArrayTypeSyntax or PointerTypeSyntax)
            outer = outer.Parent;
        return outer.Parent switch
        {
            VariableDeclarationSyntax declaration => declaration.Type == outer,
            ParameterSyntax parameter => parameter.Type == outer,
            MethodDeclarationSyntax method => method.ReturnType == outer,
            PropertyDeclarationSyntax property => property.Type == outer,
            EventDeclarationSyntax eventDeclaration => eventDeclaration.Type == outer,
            DelegateDeclarationSyntax delegateDeclaration => delegateDeclaration.ReturnType == outer,
            LocalFunctionStatementSyntax function => function.ReturnType == outer,
            BaseTypeSyntax => true,
            TypeArgumentListSyntax => true,
            TypeOfExpressionSyntax => true,
            DefaultExpressionSyntax => true,
            CastExpressionSyntax => true,
            ObjectCreationExpressionSyntax => true,
            _ => false,
        };
    }

    private static bool TryDeclaration(SyntaxNode node, out SyntaxToken token, out string kind)
    {
        token = default;
        kind = "";
        switch (node)
        {
            case InterfaceDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "interface";
                break;
            case EnumDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "enum";
                break;
            case TypeDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "class";
                break;
            case DelegateDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "type";
                break;
            case MethodDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "method";
                break;
            case ConstructorDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "method";
                break;
            case DestructorDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "method";
                break;
            case PropertyDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "property";
                break;
            case EventDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "field";
                break;
            case EnumMemberDeclarationSyntax declaration:
                token = declaration.Identifier;
                kind = "constant";
                break;
            case VariableDeclaratorSyntax declaration when declaration.Parent?.Parent is FieldDeclarationSyntax field:
                token = declaration.Identifier;
                kind = field.Modifiers.Any(SyntaxKind.ConstKeyword) ? "constant" : "field";
                break;
            case VariableDeclaratorSyntax declaration when declaration.Parent?.Parent is EventFieldDeclarationSyntax:
                token = declaration.Identifier;
                kind = "field";
                break;
            case VariableDeclaratorSyntax declaration when declaration.Parent?.Parent is LocalDeclarationStatementSyntax local && local.Parent is GlobalStatementSyntax:
                token = declaration.Identifier;
                kind = local.Modifiers.Any(SyntaxKind.ConstKeyword) ? "constant" : "variable";
                break;
            case LocalFunctionStatementSyntax declaration when declaration.Parent is GlobalStatementSyntax:
                token = declaration.Identifier;
                kind = "function";
                break;
        }
        return kind.Length != 0 && !token.IsMissing;
    }

    private static ISymbol? SingleSymbol(SymbolInfo info)
    {
        if (info.Symbol is not null)
            return info.Symbol;
        return info.CandidateSymbols.Length == 1 ? info.CandidateSymbols[0] : null;
    }

    private static bool HasProjectLocation(ISymbol symbol, Dictionary<SyntaxTree, SourceDocument> sources) =>
        symbol.Locations.Any(location => location.SourceTree is not null && sources.ContainsKey(location.SourceTree));

    private static (List<SourcePosition> Definitions, bool External) SymbolLocations(ISymbol? symbol, Dictionary<SyntaxTree, SourceDocument> sources)
    {
        if (symbol is IAliasSymbol alias)
            symbol = alias.Target;
        if (symbol is null)
            return ([], false);
        var definitions = new HashSet<SourcePosition>();
        var outside = false;
        foreach (var location in symbol.Locations)
        {
            if (location.SourceTree is not null && sources.TryGetValue(location.SourceTree, out var source))
                definitions.Add(Position(location, source.Path));
            else if (location.IsInMetadata || location.IsInSource)
                outside = true;
        }
        return (OrderedPositions(definitions), definitions.Count == 0 && outside);
    }
    private static List<SourcePosition> RelatedDeclarations(ISymbol symbol, SourcePosition current, Dictionary<SyntaxTree, SourceDocument> sources)
    {
        var positions = new HashSet<SourcePosition>();
        void AddLocations(ISymbol? related)
        {
            if (related is null)
                return;
            foreach (var location in related.Locations)
            {
                if (location.SourceTree is not null && sources.TryGetValue(location.SourceTree, out var source))
                    positions.Add(Position(location, source.Path));
            }
        }

        AddLocations(symbol);
        INamedTypeSymbol? familyType = symbol as INamedTypeSymbol;
        if (symbol is IMethodSymbol method)
        {
            AddLocations(method.PartialDefinitionPart);
            AddLocations(method.PartialImplementationPart);
            if (method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor or MethodKind.Destructor)
                familyType = method.ContainingType;
        }
        else if (symbol is IPropertySymbol property)
        {
            AddLocations(property.PartialDefinitionPart);
            AddLocations(property.PartialImplementationPart);
        }
        else if (symbol is IEventSymbol eventSymbol)
        {
            AddLocations(eventSymbol.PartialDefinitionPart);
            AddLocations(eventSymbol.PartialImplementationPart);
        }

        if (familyType is not null && familyType.TypeKind is TypeKind.Class or TypeKind.Struct)
        {
            AddLocations(familyType);
            foreach (var member in familyType.GetMembers())
            {
                if (member is not IMethodSymbol familyMethod || familyMethod.IsImplicitlyDeclared)
                    continue;
                if (familyMethod.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor or MethodKind.Destructor)
                    AddLocations(familyMethod);
            }
        }
        positions.Remove(current);
        return OrderedPositions(positions);
    }


    private static async Task<List<SourcePosition>> FindReferencesAsync(ISymbol symbol, Solution solution, Dictionary<SyntaxTree, SourceDocument> sources)
    {
        var results = await SymbolFinder.FindReferencesAsync(symbol, solution);
        var declarationPositions = new HashSet<SourcePosition>();
        var references = new HashSet<SourcePosition>();
        foreach (var result in results)
        {
            foreach (var location in result.Definition.Locations)
            {
                if (location.SourceTree is not null && sources.TryGetValue(location.SourceTree, out var source))
                    declarationPositions.Add(Position(location, source.Path));
            }
            foreach (var reference in result.Locations)
            {
                var location = reference.Location;
                if (reference.IsImplicit || location.SourceTree is null || !sources.TryGetValue(location.SourceTree, out var source))
                    continue;
                var root = await location.SourceTree.GetRootAsync();
                var token = root.FindToken(location.SourceSpan.Start);
                if (!token.IsKind(SyntaxKind.IdentifierToken))
                    continue;
                if (reference.IsCandidateLocation)
                {
                    if (token.Parent is not SimpleNameSyntax name)
                        continue;
                    var model = await reference.Document.GetSemanticModelAsync();
                    if (model is null || SingleSymbol(model.GetSymbolInfo(name)) is null)
                        continue;
                }
                references.Add(Position(token.GetLocation(), source.Path));
            }
        }
        references.ExceptWith(declarationPositions);
        return OrderedPositions(references);
    }

    private static SourcePosition Position(Location location, string path)
    {
        var position = location.GetLineSpan().StartLinePosition;
        return new SourcePosition(path, position.Line + 1, position.Character + 1);
    }

    private static List<SourcePosition> OrderedPositions(IEnumerable<SourcePosition> positions) => positions
        .OrderBy(position => position.File, StringComparer.Ordinal)
        .ThenBy(position => position.Line)
        .ThenBy(position => position.Column)
        .ToList();

    private static void SortAndShuffle<T>(List<T> candidates, Func<T, SourcePosition> position, long seed)
    {
        candidates.Sort((left, right) =>
        {
            var a = position(left);
            var b = position(right);
            var fileOrder = StringComparer.Ordinal.Compare(a.File, b.File);
            if (fileOrder != 0)
                return fileOrder;
            var lineOrder = a.Line.CompareTo(b.Line);
            return lineOrder != 0 ? lineOrder : a.Column.CompareTo(b.Column);
        });
        var random = new Mulberry32(unchecked((uint)seed));
        for (var i = candidates.Count - 1; i > 0; i--)
        {
            var j = (int)(random.NextDouble() * (i + 1));
            (candidates[i], candidates[j]) = (candidates[j], candidates[i]);
        }
    }
}

public sealed class Mulberry32(uint seed)
{
    private uint state = seed;

    public double NextDouble()
    {
        unchecked
        {
            var t = state += 0x6D2B79F5u;
            t = (t ^ (t >> 15)) * (t | 1u);
            t ^= t + (t ^ (t >> 7)) * (t | 61u);
            return (t ^ (t >> 14)) / 4294967296.0;
        }
    }
}

internal sealed record OracleRequest(int SchemaVersion, string Language, string[] Files, long Seed, int MaxSites, int MaxDeclarations);
internal sealed record SourcePosition(string File, int Line, int Column);
internal sealed record SourceDocument(Document Document, string Path);
internal sealed record SiteCandidate(SourceDocument Source, SimpleNameSyntax Node, SourcePosition Position);
internal sealed record DeclarationCandidate(SourceDocument Source, SyntaxNode Node, SyntaxToken Token, string Kind, SourcePosition Position);
internal sealed record OracleIdentity(string Name, string Version);
internal sealed record OracleSite(string File, int Line, int Column, string Name, string Form, List<SourcePosition> Definitions, bool External);
internal sealed record OracleDeclaration(string File, int Line, int Column, string Name, string Kind, List<SourcePosition> References, List<SourcePosition> RelatedDeclarations);
internal sealed record OracleDiagnostics(int Files, int UnresolvedSites, List<string> Errors);
internal sealed record OracleResponse(int SchemaVersion, string Language, OracleIdentity Oracle, List<OracleSite> Sites, List<OracleDeclaration> Declarations, OracleDiagnostics Diagnostics);
