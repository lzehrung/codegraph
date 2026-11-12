export class Component {
  #value() { return 1; } // @def tsxPrivate=#value
  render() { return <span>{this.#value()}</span>; } // @ref tsxPrivate @goto tsxPrivate
}
class ComponentDecoy {
  #value() { return 0; } // @not-ref tsxPrivate
}
