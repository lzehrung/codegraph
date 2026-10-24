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
    int selected = pick(3); // @goto pick @known-gap using_overload_goto observed=not_found
    int selectedReference = pick(3); // @ref pick @known-gap using_overload_reference observed=none
    int selectedDouble = pick(3.5); // @goto pickDouble=pick @known-gap using_overload_goto observed=not_found
    int selectedDoubleReference = pick(3.5); // @ref pickDouble @known-gap using_overload_reference observed=none
    int zero = orbit::detail::choose(); // @ref chooseVoid @goto chooseVoid=choose
    int first = base.step(3); // @goto step @known-gap qualified_member_goto observed=not_found
    int second = base.step(3.5); // @ref stepDouble @known-gap base-double-step-reference observed=none @not-ref step
    int third = worker.run(4); // @goto run @known-gap receiver_member_goto observed=not_found
    int fourth = worker.run(4.5); // @ref runDouble @known-gap double-run-reference observed=none @not-ref run
    int fourthGoto = worker.run(4.5); // @goto runDouble @known-gap double-run-goto observed=not_found @not-ref run
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
