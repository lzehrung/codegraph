#include "./utils.h"
#include "./helpers.h"

int main(void) {
  int value = helper_function(2);
  int other = helper_from_helpers();
  return value + other;
}
