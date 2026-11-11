export class Owner {
  #method() { return 1; } // @def privateMethod=#method @coverage privateMethod complete
  #field = 1; // @def privateField=#field @coverage privateField complete
  run(other: Owner) {
    this.#method(); // @ref privateMethod @goto privateMethod
    return #field in other; // @ref privateField @goto privateField
  }
  nested() {
    return class Inner {
      read(other: Owner) { return other.#field; } // @ref privateField @goto privateField
    };
  }
}
class Decoy {
  #field = 2; // @not-ref privateField
  #method() {} // @not-ref privateMethod
}
