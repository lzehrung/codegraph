package main

import (
	"fmt"
	"os"
)

type MyStruct struct {
	Field string
}

func (m *MyStruct) Method() {
	fmt.Println(m.Field)
}

func Function() {
	fmt.Println("Hello")
}

