class Box { target(x: number) { return x; } accepted() { return this.target(1); } rejected() { return this.target(1, 2); } }
