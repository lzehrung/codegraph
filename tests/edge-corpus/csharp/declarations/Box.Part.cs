using Edge.Core;

namespace Edge.Core
{
    public partial class Box<T> // @def boxPart=Box
    {
        public int Extra => 7; // @def extra=Extra
        public T Echo(T item) => this.Value; // @def echo=Echo @ref value @known-gap this-member-property observed=none
        public T Echo(string item) => this.Value; // @def echoString=Echo
        public T Shadow(T Value) => Value; // @not-ref value
    }
}
