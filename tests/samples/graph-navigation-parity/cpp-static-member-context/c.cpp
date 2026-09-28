struct C {
  int instance();
  static int shared();
  static int s();
  int m();
};
int C::instance() { return 1; }
int C::shared() { return 2; }
int C::s() { return C::instance() + instance() + shared(); }
int C::m() { return C::instance() + instance() + shared(); }
struct D {
  static int t() { return helper(); }
  int helper() { return 3; }
};
namespace ns { int f(); }
int ns::f() { return C::instance(); }
