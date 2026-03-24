import Utils
import Helpers

func main() {
  let value = Utils.helperFunction(1)
  let utility = Utils.UtilityStruct(value: value)
  let other = Helpers.helperFromHelpers()
  print(utility.value + other)
}
