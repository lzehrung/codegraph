#include "a.hpp"
#include "b.hpp"
int use_a(a::Box& box) { return box.run(); }
int use_b(b::Box& box) { return box.run(); }
