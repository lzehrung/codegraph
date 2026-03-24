import utils.helperFunction
import utils.UtilityClass
import helpers.helperFromHelpers

fun main() {
  val value = helperFunction(1)
  val utility = UtilityClass(value)
  val other = helperFromHelpers()
  println(utility.value + other)
}
