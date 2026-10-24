package api;

public interface Named { // @def Named
    default String label() { return "named"; } // @def label
}
