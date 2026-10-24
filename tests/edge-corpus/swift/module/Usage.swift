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

// @ref announce @known-gap default-method observed=none
func useDefault(_ value: Labelled) { value.announce() }
// @goto announce @known-gap default-method observed=not_found
let defaultMethod = Labelled.announce

func useMembers(_ value: Labelled) {
    // @ref labelName
    let title = value.relayName
    // @ref labelledSend @known-gap argument-label observed=none
    value.send(to: title)
    // @ref sendAgain @known-gap unlabeled-overload observed=none
    value.send(title)
    // @ref description
    let text = value.description
    // @ref count
    let total = Labelled.count
    // @ref nested @known-gap nested-type observed=none
    let child = Labelled.nested()
    // @goto nested @known-gap nested-type observed=not_found
    let nestedConstructor = Labelled.nested.self
    // @ref nestedValue @known-gap nested-property observed=none
    let number = child.nestedValue
    let another = Labelled()
    // @ref announce @known-gap default-method observed=none
    value.announce()
    // @ref labelledSend @known-gap argument-label observed=none
    value.send(to: "closure")
    // @def captured
    let captured = "captured value"
    // @ref captured
    let closure = { captured + value.relayName }
    _ = closure()
    // @ref warm @known-gap enum-shorthand observed=none
    let selected: ColorMode = .warm
    // @goto warm @known-gap enum-shorthand observed=not_found
    let warmConstructor = ColorMode.warm
    // @ref cool @known-gap enum-shorthand observed=none
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