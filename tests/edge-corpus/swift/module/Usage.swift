// @ref Labelled
func construct() -> Labelled { Labelled() }
// @goto Labelled
let typeReference = Labelled.self
// @ref Labelled
let typedAgain: Labelled.Type = Labelled.self
// @ref Labelled
let typedThird: Labelled.Type = Labelled.self
// @ref Labelled
let typedFourth: Labelled.Type = Labelled.self

// @ref announce
func useDefault(_ value: Labelled) { value.announce() }
// @goto announce
let defaultMethod = Labelled.announce

func useMembers(_ value: Labelled) {
    // @ref labelName
    let title = value.relayName
    // @ref labelledSend
    value.send(to: title)
    // @ref sendAgain
    value.send(title)
    // @ref description
    let text = value.description
    // @ref count
    let total = Labelled.count
    // @ref nested
    let child = Labelled.nested()
    // @goto nested
    let nestedConstructor = Labelled.nested.self
    // @ref nestedValue
    let number = child.nestedValue
    let another = Labelled()
    // @ref announce
    value.announce()
    // @ref labelledSend
    value.send(to: "closure")
    // @def captured
    let captured = "captured value"
    // @ref captured
    let closure = { captured + value.relayName }
    _ = closure()
    // @ref warm
    let selected: ColorMode = .warm
    // @goto warm
    let warmConstructor = ColorMode.warm
    // @ref cool
    let alternate: ColorMode = .cool
    // @not-ref captured
    let stringDecoy = "captured"
    // @not-ref captured
    let interpolationDecoy = "\("captured")"
    // @not-ref-block captured
    let multilineDecoy = """
        captured
        """
    _ = (text, total, another, selected, alternate, stringDecoy, interpolationDecoy, multilineDecoy, number, nestedConstructor, warmConstructor, defaultMethod)
}

// @not-ref labelledSend
func unrelated() { let decoy = "send(to:)"; _ = decoy }