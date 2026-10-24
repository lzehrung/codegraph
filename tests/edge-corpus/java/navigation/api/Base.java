package api;

public class Base extends GrandBase {
    protected String baseTag() { return "base"; } // @def baseTag
    protected int pick(int value) { return value; } // @def basePick=pick
    public String choose(String value) { return value; } // @def baseChoose=choose
    public void mix(int first, int second) {} // @def instanceMix=mix
}
