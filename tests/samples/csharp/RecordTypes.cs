namespace RecordSample {
  public interface ISized {
    int Size { get; }
  }

  public record Point(int X, int Y);

  public record NamedShape(int Size) : ISized;
}
