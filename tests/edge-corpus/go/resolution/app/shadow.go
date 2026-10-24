package app

import kit "example.com/edge/widget"

func nest(total int) int { // @def total
	seen := total // @ref total @goto total
	{
		total := 4 // @def innerTotal=total
		return total + seen // @ref innerTotal @goto innerTotal @not-ref total
	}
}

func stillQualified() int {
	return kit.Exported()
}

func shadeAlias() int {
	kit := 0 // @def kitLocal=kit
	return kit // @ref kitLocal @goto kitLocal
}
