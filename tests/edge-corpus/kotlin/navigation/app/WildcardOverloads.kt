package sample.app

import sample.model.*

fun wildcardOverload(): String = overload(1L) // @not-ref overload @not-ref overloadString @not-ref overloadLong
