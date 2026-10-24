#include "api.hpp"
#include "other.hpp"
using orbit::model::Worker;
using orbit::detail::pick; // @ref pick @known-gap using_declaration_reference observed=none
namespace om = orbit::model;
namespace text = orbit::model::nested;
// step, Worker, identity are decoys in this comment.
int exercise() {
    Worker worker;
    orbit::detail::Base& base = worker;
    int selected = pick(3); // @not-ref pick @not-ref pickDouble
    int selectedReference = pick(3); // @not-ref pick @not-ref pickDouble
    int selectedDouble = pick(3.5); // @not-ref pick @not-ref pickDouble
    int selectedDoubleReference = pick(3.5); // @not-ref pick @not-ref pickDouble
    int zero = orbit::detail::choose(); // @ref chooseVoid @goto chooseVoid=choose
    int first = base.step(3); // @not-ref step @not-ref stepDouble
    int second = base.step(3.5); // @not-ref step @not-ref stepDouble
    int third = worker.run(4); // @not-ref run @not-ref runDouble
    int fourth = worker.run(4.5); // @not-ref run @not-ref runDouble
    int fourthGoto = worker.run(4.5); // @not-ref run @not-ref runDouble
    int fifth = om::identity<int>(first); // @ref identity @goto identity
    int sixth = text::launch(worker); // @ref launch @goto launch
    int made = Worker::make(); // @goto make @known-gap using_type_static_member_goto observed=not_found
    int converted = worker.convert(1); // @goto convert @known-gap using_type_member_goto observed=not_found
    int ambiguousCall = orbit::detail::ambiguous(); // @not-ref ambiguousZero @not-ref ambiguousDefault
    int wrongArity = orbit::detail::only(); // @not-ref singleArity
    int noRunArity = worker.run(); // @not-ref run @not-ref runDouble
    ++Worker::instances; // @goto instances @known-gap qualified_static_goto observed=not_found
    int seventh = om::identity<int>(sixth); // @ref identity @goto identity
    int eighth = text::launch(worker); // @ref launch @goto launch
    int ninth = om::identity<int>(seventh); // @ref identity @goto identity
    int tenth = text::launch(worker); // @ref launch @goto launch
    unrelated::Worker decoyWorker;
    int decoy_call = unrelated::step(1) + decoyWorker.run(1); // @not-ref step @not-ref run
    return selected + first + second + third + fourth + fourthGoto + fifth + sixth + seventh + eighth + ninth + tenth + decoy_call + EDGE_SCALE(1);
}
const char* decoy = R"raw(step Worker::run identity orbit::detail::Base)raw";
