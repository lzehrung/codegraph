#include "api.hpp"
namespace orbit::detail {
int Base::step(int amount) { return amount; } // @ref step
int Base::step(double amount) { return static_cast<int>(amount); }
}
namespace orbit::model {
int Worker::instances = 0; // @ref instances @known-gap qualified_static_reference observed=none
int Worker::run(int amount) { // @ref run
    return Base::step(amount); // @ref step @known-gap qualified_member_reference observed=none
}
int Worker::run(double amount) {
    return Base::step(amount); // @ref step @known-gap qualified_member_reference observed=none
}
int nested::launch(Worker& worker) { return worker.run(1); } // @ref run @known-gap receiver_member_reference observed=none
}
