namespace Edge.Core;

public class BasePicker
{
    public int Pick(int value) => value; // @def basePick=Pick
}

public class DerivedPicker : BasePicker
{
    public int Pick(string value) => value.Length; // @def derivedPick=Pick
    public int InvalidCall() => Pick(1); // @not-ref basePick
}
