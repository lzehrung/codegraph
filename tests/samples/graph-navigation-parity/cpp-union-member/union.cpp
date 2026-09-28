union Packet { int read(int offset) { return offset; } };
int use(Packet p) { return p.read(1); }
