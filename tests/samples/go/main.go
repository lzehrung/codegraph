package main

import (
  "./utils"
  "./helpers"
)

func main() {
  utils.HelperFunction()
  u := utils.NewUtilityClass(100)
  println(u.GetValue())
  utils.ReExportedHelper()
  helpers.HelperFromHelpers()
  println(utils.ConstantValue)
  another := helpers.AnotherHelper()
  println(another)
}