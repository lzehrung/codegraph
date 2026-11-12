global using static Edge.Core.ScopeMix;

namespace Edge.App;

public class GlobalStaticConsumer
{
    public int Call() => Mix(1); // @ref staticMix @goto staticMix=Mix
}
