#pragma once

namespace demo {
enum class Mode {
  Fast,
  Slow
};

using Count = int;

class Engine {
public:
  int run() { return 1; }
};

template <typename T>
T combine(T left, T right) {
  return left + right;
}
} // namespace demo
