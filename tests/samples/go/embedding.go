package main

type EmbeddedInner struct {
	Name string
}

func (i EmbeddedInner) GetName() string {
	return i.Name
}

type EmbeddingOuter struct {
	EmbeddedInner
	Extra int
}

func (o EmbeddingOuter) ValueReceiverMethod() int {
	return o.Extra
}

func useEmbedding() int {
	o := EmbeddingOuter{EmbeddedInner: EmbeddedInner{Name: "x"}, Extra: 1}
	_ = o.GetName()
	return o.ValueReceiverMethod()
}
