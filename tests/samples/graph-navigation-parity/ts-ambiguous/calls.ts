class Left { helper(): number { return 1; } }
class Right { helper(): number { return 2; } }
class Ambiguous extends Left, Right {
  throughThis(): number { return this.helper(); }
  throughSuper(): number { return super.helper(); }
}
