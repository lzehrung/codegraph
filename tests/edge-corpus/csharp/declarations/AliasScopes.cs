namespace Edge.First
{
    using @X = Edge.Core;
    using PT = Edge.Core.Point; // @ref point

    public class FirstConsumer
    {
        public PT Direct() => default; // @ref point @goto point=PT
        public X.Point Qualified() => default; // @ref point
        public X::Point AliasQualified() => default; // @goto point=Point
        public X::Box<int> GenericAlias() => default; // @goto boxPart=Box
    }
}

namespace Edge.Second
{
    using @X = Edge.Core;
    using PT = Edge.Core.Point; // @ref point

    public class SecondConsumer
    {
        public PT Direct() => default; // @ref point @goto point=PT
        public X.Point Qualified() => default; // @goto point=Point
    }
}
