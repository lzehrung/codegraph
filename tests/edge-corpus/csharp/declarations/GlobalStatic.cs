global using static Edge.Core.ScopeMix;

namespace Edge.App;

public class GlobalStaticConsumer
{
    public int Call() => Mix(1); // @goto staticMix=Mix @known-gap global_static_import_unsupported observed=not_found
}
