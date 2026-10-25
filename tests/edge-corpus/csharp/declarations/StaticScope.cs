namespace Edge.Core;

public class ScopeMix
{
    public static int Mix(int value) => value; // @def staticMix=Mix
    public int Mix(int first, int second) => first + second; // @def instanceMix=Mix
    private protected static int Hidden(int value) => value; // @def protectedMix=Hidden
}
