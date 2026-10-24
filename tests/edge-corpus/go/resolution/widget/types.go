package widget

// @def Counter @coverage Counter complete
type Counter struct {
	Label  string // @def Label @coverage Label complete
	secret int    // @def secret
}

// @def Inner
type Inner struct {
	Name string // @def Name
}

// @def Outer
type Outer struct {
	Inner // @ref Inner
	extra int
}

// @def Runner
type Runner interface {
	Run() string
}
