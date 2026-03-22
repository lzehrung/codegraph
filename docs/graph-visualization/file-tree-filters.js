/**
 * Pure filter / presentation helpers for the file tree.
 * No DOM dependency except `highlightMatch` which creates a DocumentFragment.
 */

export function kindAbbrev(kind) {
  const map = { function: "fn", class: "cls", type: "ty", variable: "var", import: "imp" };
  return map[kind] || (kind ? kind.slice(0, 3) : "?");
}

export function matchesFilter(name, filter) {
  if (!filter) return true;
  return name.toLowerCase().includes(filter.toLowerCase());
}

export function subtreeMatchesFilter(node, filter) {
  if (!filter) return true;
  if (matchesFilter(node.name, filter)) return true;
  if (node.type === "directory" && node.children) {
    return node.children.some((c) => subtreeMatchesFilter(c, filter));
  }
  if (node.type === "file" && node.symbols) {
    return node.symbols.some((s) => matchesFilter(s.name, filter));
  }
  return false;
}

/**
 * Create a DOM fragment that wraps the first occurrence of `filter` in a
 * `<mark>` element.  Returns a plain TextNode when there is no match or no
 * filter.
 *
 * NOTE: this is the only function in the module that touches the DOM.
 */
export function highlightMatch(text, filter) {
  if (!filter) return document.createTextNode(text);
  const lower = text.toLowerCase();
  const idx = lower.indexOf(filter.toLowerCase());
  if (idx < 0) return document.createTextNode(text);

  const frag = document.createDocumentFragment();
  if (idx > 0) frag.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.textContent = text.slice(idx, idx + filter.length);
  frag.appendChild(mark);
  if (idx + filter.length < text.length) {
    frag.appendChild(document.createTextNode(text.slice(idx + filter.length)));
  }
  return frag;
}
