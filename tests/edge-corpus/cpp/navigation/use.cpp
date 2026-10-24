#include "api.hpp"
#include "other.hpp"
using orbit::model::Worker;
using namespace orbit::detail;
namespace om = orbit::model;
namespace text = orbit::model::nested;
// step, Worker, identity are decoys in this comment.
int exercise() {
    Worker worker;
    Base& base = worker;
    int first = base.step(3); // @goto step @known-gap qualified_member_goto observed=not_found
    int second = base.step(3.5); // @ref step @known-gap qualified_member_reference observed=none
    int third = worker.run(4); // @goto run @known-gap receiver_member_goto observed=not_found
    int fourth = worker.run(4.5); // @ref run @known-gap receiver_member_reference observed=none
    int fifth = om::identity<int>(first); // @ref identity @goto identity
    int sixth = text::launch(worker); // @ref launch @goto launch
    ++Worker::instances; // @goto instances @known-gap qualified_static_goto observed=not_found
    int seventh = om::identity<int>(sixth); // @ref identity @goto identity
    int eighth = text::launch(worker); // @ref launch @goto launch
    int ninth = om::identity<int>(seventh); // @ref identity @goto identity
    int tenth = text::launch(worker); // @ref launch @goto launch
    int decoy_call = unrelated::step(1); // @not-ref step @not-ref run
    return first + second + third + fourth + fifth + sixth + seventh + eighth + ninth + tenth + decoy_call + EDGE_SCALE(1);
}
const char* decoy = R"raw(step Worker::run identity orbit::detail::Base)raw";
