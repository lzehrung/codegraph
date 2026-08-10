actor Counter {
  private var value: Int = 0

  func increment() -> Int {
    value += 1
    return value
  }
}
