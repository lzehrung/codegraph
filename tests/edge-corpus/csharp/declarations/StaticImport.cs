using static Edge.Core.ScopeMix;

namespace Edge.App;

public class StaticImportConsumer
{
    public int Call() => Mix(1); // @goto staticMix=Mix
    public int WrongArity() => Mix(1, 2); // @not-ref instanceMix
    public int CheckProtected() => Hidden(1); // @not-ref protectedMix
}
