export async function run(flag: boolean): Promise<string> {
  let lifecycle: typeof import("./lifecycle.js") | undefined;
  if (flag) {
    lifecycle = await import("./lifecycle.js");
    return lifecycle.create();
  }
  return "";
}

export async function other(): Promise<string> {
  const decoy = await import("./decoy.js");
  return decoy.create();
}
