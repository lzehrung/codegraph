package sample.model

open class SpreadBase {
    fun hit(value: Int): String = value.toString() // @def spreadBase=hit
}

class SpreadDerived : SpreadBase() {
    fun hit(value: String): String = value // @def spreadDerived=hit
    // No vararg overload: the spread call below must not bind either method.
    fun use(values: IntArray): String = hit(*values) // @not-ref spreadDerived @not-ref spreadBase
}
