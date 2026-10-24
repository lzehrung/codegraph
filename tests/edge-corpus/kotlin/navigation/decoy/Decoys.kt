package sample.decoy

// Same short names in another package must not become navigation targets.
data class Record(val name: String)

fun render(record: Record): String = record.name

class Box(val payload: String) {
    fun read(): String = payload
}
