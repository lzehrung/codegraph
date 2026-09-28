class Cfg { public: static int load() { return 1; } };
int boot() { return Cfg::load(); }
