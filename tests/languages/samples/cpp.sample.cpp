#include "./utils.hpp"

namespace demo {
class MyClass {
public:
  int method(int x) { return x; }
};

struct MyStruct {
  int value;
};

enum class MyMode {
  One,
  Two
};
}

template <typename T>
T add(T a, T b) {
  return a + b;
}
