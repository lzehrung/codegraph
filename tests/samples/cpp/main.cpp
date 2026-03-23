#include "./utils.hpp"
#include "./helpers.hpp"

int main() {
  int value = helperFunction(2);
  UtilityClass utility{value};
  int other = helperFromHelpers();
  return utility.value + other;
}
