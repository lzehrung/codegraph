#include "api.h"

static int local_tool(int input) { // @def local_consumer=local_tool
    return input - 10;
}

int consume(void) { // @def consume
    Record item = { .count = 2, .label = "ok" };
    Payload payload = { .number = item.count };
    Comparator compare = public_value; // @ref public_value @goto public_value
    int from_header = public_value(item.count); // @ref public_value @goto public_value
    int same = shared_name(from_header); // @ref shared_name @goto shared_name
    int local = local_tool(same); // @ref local_consumer @goto local_consumer=local_tool
    int state = STATUS_READY; // @goto STATUS_READY
    int still = payload.number; // @goto number @known-gap union_member_navigation observed=not_found
    int member_count = item.count; // @goto count @known-gap struct_member_navigation observed=not_found
    int first_char = item.label[0]; // @goto label @known-gap struct_member_navigation observed=not_found
    int type_size = sizeof(Record) + sizeof(Payload); // @goto Record @goto Payload
    int comparator_size = sizeof(Comparator); // @goto Comparator
    int done_state = STATUS_DONE; // @goto STATUS_DONE
    int macro_decoy = DECOY_MACRO(STATUS_DONE);
    // public_value STATUS_READY label are decoys in this comment.
    const char *text = "public_value STATUS_READY label"; // @not-ref public_value @not-ref STATUS_READY @not-ref label
    return compare(from_header) + local + state + still + member_count + first_char + type_size + comparator_size + done_state + macro_decoy + text[0];
}
