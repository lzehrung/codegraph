namespace Edge.Core;

public class OptionalBase
{
    public virtual int Take(int value = 0) => value; // @def baseTake=Take
}

public class OptionalDerived : OptionalBase
{
    public override int Take(int value) => value; // @def derivedTake=Take
    public int InvalidCall() => Take(); // @not-ref baseTake
}
