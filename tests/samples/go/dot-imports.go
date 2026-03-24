package main

import (
  . "./utils"
  _ "./helpers"
)

func dotImportExample() {
  instance := NewUtilityClass(3)
  println(instance.GetValue())
}
