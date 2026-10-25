using Z = Edge.Core;

namespace Edge.Shadowed
{
    public class ShadowedConsumer
    {
        public Z.Point Qualified() => default; // @not-ref point @not-ref shadowPoint
    }
}

namespace Edge.Unshadowed
{
    public class UnshadowedConsumer
    {
        public Z.Point Qualified() => default; // @ref point @goto point=Point
    }
}
