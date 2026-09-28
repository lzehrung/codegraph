export function run(args: string[], store: { close(): void }, value: string): void {
  const handle = args[0]?.trim();
  const lazy = import("./other");
  /re/.test(value);
  store?.close();
  void handle;
  void lazy;
}
