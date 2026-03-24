import utils.*

fun consumeAlias(): UtilityAlias {
  return UtilityFactory.create(2)
}

fun consumeCompanion(): UtilityClass {
  return CompanionCarrier.build(3)
}
