namespace Edge.App;

public class StaticScope
{
    public int Call() => Edge.Core.ScopeMix.Mix(1); // @goto staticMix=Mix
    public int WrongReceiver() => Edge.Core.ScopeMix.Mix(1, 2); // @not-ref instanceMix
    public int PartialType() => Edge.Core.Helpers.Two(1, 2); // @goto twoPair=Two
}
