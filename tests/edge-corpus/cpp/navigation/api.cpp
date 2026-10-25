#include "api.hpp"
namespace orbit::detail {
int Base::step(int amount) { return amount; } // @ref step
int Base::step(double amount) { return static_cast<int>(amount); }
int pick(int amount) { return amount; }
int pick(double amount) { return static_cast<int>(amount); } // @ref pickDouble
int choose(void) { return 0; }
int choose(int amount) { return amount; }
int untouched() { return 0; } // @def untouched @coverage untouched complete
int beforeDeclaration() { return laterValue; } // @not-ref laterValue
int laterValue; // @def laterValue @coverage laterValue complete
int arrayPick(int* values) { return values[0]; } // @ref arrayPick
}
namespace orbit::model {
int Worker::instances = 0; // @ref instances @known-gap qualified_static_reference observed=none
int Worker::run(int amount) { // @ref run
    this->step(amount); // @not-ref step @not-ref stepDouble
    this->step(amount); // @not-ref step @not-ref stepDouble
    return Base::step(amount); // @not-ref step @not-ref stepDouble
}
int Worker::run(double amount) {
    return Base::step(amount); // @not-ref step @not-ref stepDouble
}
int Worker::make() { return 1; } // @ref make
template <typename T> T Worker::convert(T value) { return value; } // @ref convert
int nested::launch(Worker& worker) { return worker.run(1); } // @not-ref run @not-ref runDouble
}
