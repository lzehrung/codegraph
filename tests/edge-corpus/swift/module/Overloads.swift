class MethodBase {
    func fetch(_ value: String) -> String { value } // @def baseFetch=fetch @goto baseFetch=fetch
}

class MethodChild: MethodBase {
    override func fetch(_ value: String) -> String { value } // @def childFetch=fetch @goto childFetch=fetch

    func invoke() -> String {
        let fromSelf = self.fetch("self") // @ref childFetch @goto childFetch=fetch
        let fromSuper = super.fetch("base") // @ref baseFetch @goto baseFetch=fetch
        return fromSelf + fromSuper
    }
}
