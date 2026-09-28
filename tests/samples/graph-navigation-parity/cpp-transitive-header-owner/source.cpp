#include "wrapper.hpp"
int helper() { return 1; }
int Box::run() { return helper(); }
int Box::twice() { return run() + helper(); }
