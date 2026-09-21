use tree_sitter::Language;

/// Language ids the addon can parse. Single-file components are deliberately absent: `vue` and
/// `svelte` files are split by the TypeScript side (`src/languages/file-prep.ts`) into their
/// script block (js/ts/tsx), template (html), and style (css/scss/less) support, and those block
/// languages are what reach this addon. A `vue` or `svelte` parser here would never be asked for.
pub(crate) const SUPPORTED_LANGUAGE_IDS: &[&str] = &[
    "c",
    "cpp",
    "css",
    "csharp",
    "go",
    "html",
    "java",
    "js",
    "kotlin",
    "less",
    "php",
    "python",
    "ruby",
    "rust",
    "scss",
    "sql",
    "swift",
    "ts",
    "tsx",
    "zig",
];

pub(crate) fn supported_language_ids() -> Vec<String> {
    SUPPORTED_LANGUAGE_IDS.iter().map(|entry| (*entry).to_string()).collect()
}

pub(crate) fn language_for_id(language_id: &str) -> Option<Language> {
    match language_id {
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "css" | "less" => Some(tree_sitter_css::LANGUAGE.into()),
        "csharp" => Some(arborium_c_sharp::language().into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "html" => Some(tree_sitter_html::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "js" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "kotlin" => Some(tree_sitter_kotlin_ng::LANGUAGE.into()),
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "ruby" => Some(tree_sitter_ruby::LANGUAGE.into()),
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        "scss" => Some(arborium_scss::language().into()),
        "sql" => Some(tree_sitter_sequel::LANGUAGE.into()),
        "swift" => Some(tree_sitter_swift::LANGUAGE.into()),
        "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "zig" => Some(tree_sitter_zig::LANGUAGE.into()),
        _ => None,
    }
}
