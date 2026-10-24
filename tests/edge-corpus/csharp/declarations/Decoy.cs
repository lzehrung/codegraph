namespace Edge.Decoys;

public class Box<T>
{
    public T Value { get; set; } = default!;
}

public static class Helpers
{
    public static int Build(int seed) => -seed;
}
