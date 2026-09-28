package p

import q.*

class Use {
    fun other(): Int {
        val hit = 3
        return hit
    }
    fun run(): Int = hit()
}
