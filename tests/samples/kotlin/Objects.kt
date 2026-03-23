package sample

object AppConfig {
  val name = "codegraph"
}

class Builder {
  companion object {
    fun create(): Service<String> {
      return Service("ok")
    }
  }
}
