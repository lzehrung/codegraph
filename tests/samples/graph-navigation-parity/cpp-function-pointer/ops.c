void run(void) {}
struct Ops { void (*run)(void); };
void go(struct Ops ops) { ops.run(); }
