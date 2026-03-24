#pragma once

template <typename T>
class Holder {
public:
  Holder(T value) : value_(value) {}

  T get() const {
    return value_;
  }

private:
  T value_;
};

inline int compute(int value) {
  return value + 1;
}

inline double compute(double value) {
  return value + 1.0;
}
