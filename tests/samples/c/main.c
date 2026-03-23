#include "./utils.h"
#include "./helpers.h"

int main(void) {
  int value = helper_function(2);
  Utility utility = { value };
  int other = helper_from_helpers();
  return utility.value + other;
}
