#pragma once
#define EDGE_SCALE(value) ((value) * 2) // macros are preprocessor text; navigation may not resolve expansions
namespace orbit {
namespace detail {
class Base {
public:
    int step(int amount); // @def step
    int step(double amount);
};
}
namespace model {
using detail::Base;
class Worker : public detail::Base {
public:
    int run(int amount); // @def run
    int run(double amount);
    static int instances; // @def instances
};
template <typename T>
T identity(T value) { return value; } // @def identity
namespace nested {
int launch(Worker& worker); // @def launch
}
}
}
namespace orbit_alias = orbit;
