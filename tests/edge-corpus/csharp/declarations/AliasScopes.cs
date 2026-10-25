namespace Edge.First
{
    using @X = Edge.Core;
    using PT = Edge.Core.Point; // @ref point

    public class FirstConsumer
    {
        public PT Direct() => default; // @ref point @goto point=PT
        public X.Point Qualified() => default; // @ref point @known-gap qualified_alias_reference observed=none
        public X::Point AliasQualified() => default; // @goto point=Point
        public X::Box<int> GenericAlias() => default; // @goto box=Box @known-gap generic_alias_goto observed=not_found
    }
}

namespace Edge.Second
{
    using @X = Edge.Core;
    using PT = Edge.Core.Point; // @ref point

    public class SecondConsumer
    {
        public PT Direct() => default; // @ref point @goto point=PT
        public X.Point Qualified() => default; // @goto point=Point @known-gap qualified_alias_goto observed=not_found
    }
}
