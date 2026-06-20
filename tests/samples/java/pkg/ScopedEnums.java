package sample.pkg;

public class ScopedEnums {
  public enum PrimaryMode {
    Ready
  }

  public void shadow() {
    String SecondaryMode = "shadow";
    String Missing = "shadow";
  }

  Object nested = new Object() {
    String Missing = "shadow";
  };

  public enum SecondaryMode {
    Ready
  }
}
