export const PHP_ACCURACY_LINES = {
  "app.php": [
    "<?php",
    "namespace App;",
    "function Render(): string { return 'render'; }",
    "class Grand { public static function factory(): string { return 'grand'; } }",
    "class ParentRecord extends Grand {}",
    "trait Label { public function label(): string { return $this->name; } }",
    "class Record extends ParentRecord {",
    "  use Label;",
    "  public function __construct(public string $name) {}",
    "  public function call(): string { return parent::FaCtOrY() . $this->LaBeL(); }",
    "}",
  ],
  "client.php": [
    "<?php",
    "namespace Client;",
    "use App\\Record as Target;",
    "use function App\\Render as AliasRender;",
    "function run(): string { $obj = new Target('name'); return AliasRENDER() . $obj->LABEL() . $obj->call(); }",
  ],
  "decoy.php": [
    "<?php",
    "namespace Other;",
    "function Render(): string { return 'other'; }",
    "class Record { public function label(): string { return 'other'; } public static function factory(): string { return 'other'; } }",
  ],
} as const;

export const PHP_ACCURACY_SOURCES: Record<keyof typeof PHP_ACCURACY_LINES, string> = {
  "app.php": PHP_ACCURACY_LINES["app.php"].join("\n"),
  "client.php": PHP_ACCURACY_LINES["client.php"].join("\n"),
  "decoy.php": PHP_ACCURACY_LINES["decoy.php"].join("\n"),
};
