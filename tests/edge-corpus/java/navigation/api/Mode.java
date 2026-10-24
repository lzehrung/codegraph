package api;

public enum Mode {
    ACTIVE(1), INACTIVE(0); // @def ACTIVE

    private final int numericCode;
    Mode(int numericCode) { this.numericCode = numericCode; }
    public int code() { return numericCode; } // @def code
}
