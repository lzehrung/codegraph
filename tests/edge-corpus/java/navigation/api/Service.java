package api;

public class Service extends Base implements Named { // @def Service
    public Service() {}

    public String baseValue() { return super.baseTag(); }

    public void send(String text) {} // @def sendText=send @coverage sendText partial
    public void send(int value) {} // @def sendNumber=send @coverage sendNumber partial

    public <T> T echo(T value) { return value; } // @def echo @coverage echo complete

    public static class Nested { // @def Nested
        public String name() { return "nested"; } // @def nestedName=name
    }

    public class Inner { // @def Inner
        public Service owner() { return this; } // @ref Service @known-gap inner-owner-return-type-reference observed=none
        public String ownerType() { return Service.class.getName(); } // @goto Service
    }
}
