#include "./function-pointers.h"

int use_advanced_types(void) {
  Comparator comparator = compare_values;
  enum AdvancedState state = STATE_READY;
  return comparator(4, 2) + state;
}
