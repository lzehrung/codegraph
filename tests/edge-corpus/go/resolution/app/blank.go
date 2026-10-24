package app

import _ "example.com/edge/side"

func useBlank() int {
	return SideEffect() // @not-ref SideEffect
}
