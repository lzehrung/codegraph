package app

import kit "example.com/edge/widget"

func useAlias() int {
	value := kit.Counter{Label: "edge"} // @ref Counter
	total := value.Value()               // @ref Value
	ptr := &kit.Counter{}
	total += ptr.Pointer()               // @ref Pointer
	_ = value.whisper()                  // @not-ref whisper
	_ = value.secret                     // @not-ref secret
	_ = kit.hidden()                     // @not-ref hidden
	return total + len(value.Run())      // @ref Run
}

func useRunner(value kit.Counter) kit.Runner { // @ref Runner
	return value
}
