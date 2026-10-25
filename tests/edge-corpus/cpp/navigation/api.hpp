#pragma once
#define EDGE_SCALE(value) ((value) * 2) // macros are preprocessor text; navigation may not resolve expansions
namespace orbit {
namespace detail {
class Base { // @def baseType=Base
public:
    int step(int amount); // @def step
    int step(double amount); // @def stepDouble=step
};
int pick(int amount); // @def pick
int pick(double amount); // @def pickDouble=pick
int choose(void); // @def chooseVoid=choose
int choose(int amount); // @def chooseInt=choose
int arrayPick(int values[]); // @def arrayPick
int ambiguous(); // @def ambiguousZero=ambiguous
int ambiguous(int value = 0); // @def ambiguousDefault=ambiguous
int only(int value); // @def singleArity=only
}
namespace model {
using detail::Base;
class Worker : public detail::Base { // @goto baseType=Base
public:
    int run(int amount); // @def run
    int run(double amount); // @def runDouble=run
    static int instances; // @def instances
    static int make(); // @def make
    template <typename T> T convert(T value); // @def convert
};
template <typename T>
T identity(T value) { return value; } // @def identity @coverage identity complete
namespace nested {
int launch(Worker& worker); // @def launch
}
}
}
namespace orbit_alias = orbit;
