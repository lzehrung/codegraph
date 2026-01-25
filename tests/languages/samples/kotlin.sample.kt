package sample

import utils.helperFunction
import helpers.helperFromHelpers

class MyClass {
  fun method(): String {
    return "ok"
  }
}

object MyObject {
  fun run() {}
}

interface MyInterface {
  fun act()
}

fun topLevel(x: Int): Int = x

val topValue = helperFunction(1) + helperFromHelpers()

typealias Alias = String
