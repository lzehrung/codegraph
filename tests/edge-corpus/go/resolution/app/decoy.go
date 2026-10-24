package app

func decoys() int {
	raw := `kit.Counter hidden` // @not-ref Counter @not-ref hidden
	text := "Exported"          // @not-ref Exported
	kept := 0 /* Value */       // @not-ref Value
	if len(raw) > len(text) {
		return kept
	}
	return kept
}
