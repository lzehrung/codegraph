class StaticLocal {
  void Instance() {}
  static void Shared() {}
  static void Run() { void Local() { Instance(); Shared(); } Local(); }
}
