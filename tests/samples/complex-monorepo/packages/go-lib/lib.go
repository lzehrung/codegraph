package lib

import (
	"fmt"
	oslib "os"
)

func Helper() {
	fmt.Println("helper")
	oslib.Open("test")
}
