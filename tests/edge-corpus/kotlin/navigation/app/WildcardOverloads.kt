package sample.app

import sample.model.*

fun wildcardOverload(): String = overload(1L) // @goto overloadLong=overload @known-gap wildcard_overload_goto observed=not_found
