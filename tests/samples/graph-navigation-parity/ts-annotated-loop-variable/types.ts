export interface Node {
  type: string;
  parent: Node | null;
  child(index: number): Node | null;
  childForFieldName(field: string): Node | null;
}
