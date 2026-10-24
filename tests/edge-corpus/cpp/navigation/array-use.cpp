#include "api.hpp"

int array_use() {
    int values[1] = {1};
    return orbit::detail::arrayPick(values); // @ref arrayPick @goto arrayPick
}
