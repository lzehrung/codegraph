package widget

// Same package, other file, no import.
func fromPeer() int {
	return hidden() + Exported() // @ref hidden
}
