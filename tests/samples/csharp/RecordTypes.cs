namespace RecordSample {
  public interface ISized {
    int Size();
  }

  public record Point(int X, int Y);

  public record NamedShape(int Size) : ISized {
    public int Size() => Size;
  }
}
