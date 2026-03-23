package main

import (
  helperpkg "./helpers"
  utilpkg "./utils"
)

func aliasTypeExample() {
  var direct utilpkg.UtilityClass
  direct.SetValue(101)
  println(direct.GetValue())
  _ = helperpkg.HelperFromHelpers()
}
