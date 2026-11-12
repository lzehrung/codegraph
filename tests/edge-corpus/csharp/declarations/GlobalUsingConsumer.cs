namespace Edge.App;

public class GlobalUsingConsumer
{
    public GlobalRenderable Target; // @ref globalRenderable @goto globalRenderable=GlobalRenderable
    public GlobalAlias Alias; // @goto globalRenderable=GlobalAlias
    public int Call() => GlobalCall(); // @ref globalCall @goto globalCall=GlobalCall
    public int Qualified() => GlobalTypeAlias.GlobalCall(); // @goto globalCall=GlobalCall
    public int NotARecordMember() => GlobalRecordHeight; // @not-ref globalRecordHeight
}
