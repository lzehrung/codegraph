package sample;

public interface Sized {
  int size();
}

public record Point(int x, int y) {
  public int sum() {
    return x + y;
  }
}

public record NamedShape(int size) implements Sized {
  public int size() {
    return size;
  }
}
