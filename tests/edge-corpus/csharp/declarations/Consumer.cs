namespace Edge.App
{
    using Edge.Core;
    using CoreBox = Edge.Core.Box<string>; // @def coreBox=CoreBox @ref box @known-gap alias-target observed=none
    using static Edge.Core.Helpers; // @ref helpers
    using static Edge.Core.PartialHelpers; // @ref partialHelpers

    public class Consumer
    {
        public int Run()
        {
            CoreBox box = new() { Value = "hello" }; // @goto box=CoreBox @known-gap alias-goto observed=not_found
            var first = box.Value; // @not-ref value
            var second = box.Value; // @not-ref value
            var indexed = box[0]; // indexer access
            CoreBox.Node nested = new(); // @ref node @known-gap nested-type observed=none
            nested.Id = Build(4); // @not-ref id @ref build
            var built = Build(4); // @ref build
            var two = Two(1, 2); // @not-ref twoPair @not-ref twoOne
            var tag = box.Tag(); // @not-ref tag
            var tagGoto = box.Tag(); // @not-ref tag
            var extra = box.Extra; // @not-ref extra
            var extraGoto = box.Extra; // @not-ref extra
            var echoed = box.Echo("x"); // @not-ref echoString @not-ref echo
            var escaped = new @class(); // @ref escaped
            var escapedGoto = new @class(); // @goto escaped
            var decoy = "Value Box Build Tag"; // @not-ref value
            var verbatim = @"Value Box Build Tag";
            var raw = """Value Box Build Tag Node Extra"""; // @not-ref value @not-ref build @not-ref node @not-ref extra
            var interpolated = $"Value {box.Value} Box Build Tag"; // @not-ref value
            var decoyComment = 0; // Value Box Build Tag are comment-only decoys.
            return Build(first.Length + nested.Id); // @ref build
        }
    }
}
