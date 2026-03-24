enum Status {
  case ready
  case done
}

struct UtilityFactory {
  static func build() -> WorkerImpl {
    WorkerImpl(name: "factory")
  }
}
