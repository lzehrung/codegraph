// @def Relay
protocol Relay {
    // @def protocolName=relayName
    var relayName: String { get }
    // @def protocolSend=send
    func send(to recipient: String)
}

// @def Labelled
struct Labelled: Relay {
    // @def labelName=relayName
    var relayName: String { "local" }
    // @def nested
    struct nested {
        // @def nestedValue
        let nestedValue = 5
    }
    init() {}
    // @def labelledSend=send
    func send(to recipient: String) { let _ = self.relayName }
    // @def sendAgain=send
    func send(_ recipient: String) {}
    // @def count
    static var count: Int { 3 }
    // @def description
    var description: String { relayName }
}

extension Relay {
    // @def announce
    func announce() { send(to: relayName) }
}

// @def ColorMode
enum ColorMode {
    // @def warm
    case warm
    // @def cool
    case cool
}
