package p

import q.*

class Holder {
    fun hit(): Int = 3
    fun own(): Int = hit()
}

fun run(): Int = hit()
