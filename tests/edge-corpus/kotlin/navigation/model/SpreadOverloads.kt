package sample.model

open class SpreadBase {
    fun hit(value: Int): String = value.toString() // @def spreadBase=hit
}

class SpreadDerived : SpreadBase() {
    fun hit(value: String): String = value // @def spreadDerived=hit
    fun hit(vararg values: Int): String = values.joinToString()
    fun use(values: IntArray): String = hit(*values) // @not-ref spreadDerived @not-ref spreadBase
}
