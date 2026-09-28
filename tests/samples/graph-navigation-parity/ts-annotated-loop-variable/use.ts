import type { Node } from "./types";
export function unwrap(node: Node): Node | null {
  let current: Node | null = node;
  while (current) {
    if (current.type === "a") {
      const segment = current.childForFieldName("name");
      if (!segment) break;
      current = segment;
      continue;
    }
    current = current.child(0);
  }
  return current;
}
