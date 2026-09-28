struct Box {
  int helper();
  int run();
};
struct Decoy {
  int helper();
};
struct Derived : Box {
  int again() { return Box::helper(); }
};
int Box::helper() { return 1; }
int Decoy::helper() { return 2; }
int Box::run() { return Box::helper(); }
int outside() { return Box::helper(); }
