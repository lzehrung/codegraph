#include "api.h"

static int private_helper(int input) { // @def private_helper
    return input + 1;
}

int public_value(int input) {
    return private_helper(input); // @ref private_helper @goto private_helper
}

int shared_name(int input) {
    return input * 2;
}

static int local_tool(int input) { // @def local_api=local_tool
    return input + 10;
}

int implementation_use(void) { // @def implementation_use
    return local_tool(1); // @ref local_api @goto local_api=local_tool
}
