export class JavaScriptOwner {
  #run() {} // @def jsPrivate=#run
  call() { this.#run(); } // @ref jsPrivate @goto jsPrivate
}
class JavaScriptDecoy {
  #run() {} // @not-ref jsPrivate
}
