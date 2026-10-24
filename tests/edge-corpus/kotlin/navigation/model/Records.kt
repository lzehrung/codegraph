package sample.model

// @def Record
data class Record(
    // @def name @coverage name partial
    val name: String,
    val rank: Int = 0,
)

// @def render @coverage render complete
fun render(record: Record): String = record.name

// @def summary @coverage summary complete
val Record.summary: String get() = name

// @def compact @coverage compact complete
fun Record.compact(prefix: String = "#"): String = prefix + summary

object Formatter {
    // @def format
    fun format(record: Record): String = render(record)
}

// @def build @coverage build complete
fun build(name: String): Record = Record(name)

// @def Box @coverage Box complete
class Box(
    // @def payload
    val payload: String,
) {
    // @def read
    fun read(): String = this.payload

    // @def Inner
    inner class Inner {
        // @def outerValue
        fun outerValue(): String = this@Box.payload

        // @def fromOuter
        fun fromOuter(): String = this@Box.read()
    }

    companion object {
        // @def create
        fun create(payload: String): Box = Box(payload)
    }
}

// @def overload @coverage overload complete
fun overload(value: Int): String = value.toString()

// @def overloadString=overload
fun overload(value: String): String = value

// @def defaulted @coverage defaulted complete
fun defaulted(value: String, suffix: String = "!"): String = value + suffix

// @def PairBox
data class PairBox(
    // @def left @coverage left complete
    val left: String,
    // @def right @coverage right complete
    val right: String,
)

// @def twin
val Record.twin: String get() = name

// @def objectValue
val objectValue: String = "object"

// @def objectRead @coverage objectRead complete
fun objectRead(): String = objectValue
