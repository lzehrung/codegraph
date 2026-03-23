protocol Worker {
  var name: String { get }
  func act()
}

typealias WorkerName = String

class WorkerImpl: Worker {
  let name: String

  init(name: String) {
    self.name = name
  }

  func act() {}

  subscript(index: Int) -> String {
    name
  }
}
