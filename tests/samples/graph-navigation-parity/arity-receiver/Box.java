class Box { int target(int x) { return x; } int accepted() { return this.target(1); } int rejected() { return this.target(1, 2); } }
