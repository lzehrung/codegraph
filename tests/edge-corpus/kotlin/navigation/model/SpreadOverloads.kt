package sample.model

open class SpreadBase {
    fun hit(value: Int): String = value.toString() // @def spreadBase=hit
}

class SpreadDerived : SpreadBase() {
    fun hit(value: String): String = value // @def spreadDerived=hit
    fun use(values: IntArray): String = hit(*values) // @goto spreadBase=hit @known-gap spread_overload_goto observed=not_found @not-ref spreadDerived
}
