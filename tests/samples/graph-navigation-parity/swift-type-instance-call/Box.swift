class Box {
    static func staticHelper() {}
    func instanceHelper() {}
    func caller() { Box.staticHelper() }
    func badCaller() { Box.instanceHelper() }
}
