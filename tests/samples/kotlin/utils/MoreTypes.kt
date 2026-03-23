package utils

typealias UtilityAlias = UtilityClass

object UtilityFactory {
  fun create(value: Int): UtilityClass {
    return UtilityClass(value)
  }
}

class CompanionCarrier {
  companion object {
    fun build(value: Int): UtilityClass {
      return UtilityClass(value)
    }
  }
}
