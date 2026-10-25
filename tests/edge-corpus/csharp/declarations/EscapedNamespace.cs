namespace @EdgeEscaped
{
    public class Marker {} // @def escapedMarker=Marker
}

namespace EdgeEscaped
{
    public class Consumer
    {
        public Marker Read() => default; // @goto escapedMarker=Marker
    }
}
