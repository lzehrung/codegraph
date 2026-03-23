package sample

enum class Mode {
  Fast,
  Slow,
}

typealias UserId = String

val topLevelValue = Mode.Fast.name

class Service<T>(val value: T)
