namespace a { struct C { static int f(); }; }
namespace b { namespace C { int f(); } }
int a::C::f() { return 1; }
int b::C::f() { return 2; }
int free_call() { return b::C::f() + a::C::f(); }
struct Base { int helper(); };
int Base::helper() { return 3; }
struct Derived : Base { int run(); };
struct D { int instance(); };
int D::instance() { return 4; }
int Derived::run() { return Base::helper() + D::instance(); }
