int helper(int x) { return x; }
struct Box {
  int helper();
  int run();
  int ok();
};
int Box::helper() { return 0; }
int Box::run() { return helper(1); }
int Box::ok() { return helper(); }
