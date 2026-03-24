#include "./macro-typedef.h"

int use_macro_typedef(void) {
  DECLARE_DEFAULT_COMPARATOR(comparator);
  return comparator(4, 2);
}
