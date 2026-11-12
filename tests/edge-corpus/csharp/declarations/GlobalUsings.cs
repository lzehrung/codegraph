global using Edge.Global;
global using GlobalAlias = Edge.Global.GlobalRenderable;
global using static Edge.Global.GlobalTools;
global using GlobalTypeAlias = Edge.Global.GlobalTools;

namespace Edge.Global;

public interface GlobalRenderable {} // @def globalRenderable=GlobalRenderable
public static class GlobalTools
{
    public static int GlobalCall() => 1; // @def globalCall=GlobalCall
}

public record GlobalRecord
{
    public int GlobalRecordHeight { get; init; } // @def globalRecordHeight=GlobalRecordHeight
}
