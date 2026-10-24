namespace Edge.Core;

public static partial class Helpers // @def helpers=Helpers
{
    public static int Build(int seed) => seed; // @def build=Build @coverage build complete
    public static int Two(int seed) => seed; // @def twoOne=Two
}

public partial class Box<T> // @def box=Box
{
    public T Value { get; set; } = default!; // @def value=Value
    private T Secret { get; set; } = default!; // @def secret=Secret
    public T Reveal() => this.Secret; // @ref secret
    public T this[int index] { get => Value; set => Value = value; } // indexer

    public class Node // @def node=Node
    {
        public int Id { get; set; } // @def id=Id
    }
}

public static class BoxExtensions
{
    public static string Tag<T>(this Box<T> box) => box.Value!.ToString()!; // @def tag=Tag
}

public class @class { public int Code => 9; } // @def escaped=@class
public class Point {} // @def point=Point
