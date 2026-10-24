package widget

// @def Value
func (c Counter) Value() int {
	return len(c.Label) // @ref Label @goto Label
}

// @def Pointer
func (c *Counter) Pointer() int {
	return c.Value() // @ref Value @goto Value
}

// @def GetName
func (i Inner) GetName() string {
	return i.Name
}

// @def Run
func (c Counter) Run() string {
	return c.Label
}

// @def whisper
func (c Counter) whisper() int {
	return len(c.Label)
}

func useInsidePackage() int {
	value := Counter{Label: "n"}
	ptr := &Counter{}
	outer := Outer{Inner: Inner{Name: "p"}}
	total := ptr.Pointer()
	total += value.Pointer()      // @ref Pointer @goto Pointer
	total += len(outer.Name)       // @ref Name @known-gap embedded_promoted_field observed=none
	total += len(outer.Name)       // @goto Name @known-gap embedded_promoted_field_goto observed=not_found
	total += len(outer.GetName())  // @ref GetName @goto GetName
	total += value.whisper()       // @ref whisper @goto whisper
	return total + len(value.Run())
}
