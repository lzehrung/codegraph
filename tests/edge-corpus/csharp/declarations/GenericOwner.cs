namespace Edge.Generic
{
    public class Owner<T>
    {
        public class Nested { } // @def genericNested=Nested
    }
}

namespace Edge.Generic.Owner
{
    public class Nested { } // @def decoyNested=Nested
}

namespace Edge.Generic.Use
{
    public class GenericOwnerConsumer
    {
        public Edge.Generic.Owner<int>.Nested ViaOwner() => default; // @not-ref decoyNested @goto genericNested=Nested @known-gap generic_owner_nested_unresolved observed=not_found
        public Edge.Generic.Owner.Nested ViaNamespace() => default; // @ref decoyNested @goto decoyNested=Nested
    }
}
