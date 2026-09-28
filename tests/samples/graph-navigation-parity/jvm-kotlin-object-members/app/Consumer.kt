package app

import carrier.*
import factory.*

class Consumer {
  fun run(): Int {
    UtilityFactory.create(2)
    return CompanionCarrier.build(3)
  }
}
