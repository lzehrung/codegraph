#pragma once

namespace toolkit {
class Widget {};

inline int buildWidget() {
  return 1;
}
} // namespace toolkit

namespace aliases {
using toolkit::Widget;
}
