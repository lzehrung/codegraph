package main

import (
  "./utils"
  "./helpers"
)

func main() {
  utils.HelperFunction()
  u := utils.NewUtilityClass(100)
  println(u.GetValue())
  var direct utils.UtilityClass
  direct.SetValue(101)
  println(direct.GetValue())
  utils.ReExportedHelper()
  helpers.HelperFromHelpers()
  println(utils.ConstantValue)
  another := helpers.AnotherHelper()
  println(another)
}
