int helper() { return 1; }
namespace a { struct C { int run(); }; }
namespace b { struct C { int run(); }; }
int a::C::run() { return helper(); }
int b::C::run() { return 0; }
namespace outer {
struct Box { int go(); };
int Box::go() { return helper(); }
}
