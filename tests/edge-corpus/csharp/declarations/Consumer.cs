namespace Edge.App
{
    using Edge.Core;
    using CoreBox = Edge.Core.Box<string>; // @ref box @known-gap alias-target observed=none
    using static Edge.Core.Helpers; // @ref helpers

    public class Consumer
    {
        public int Run()
        {
            CoreBox box = new() { Value = "hello" }; // @goto box @known-gap alias-goto observed=not_found
            var first = box.Value; // @ref value @known-gap receiver-property observed=none
            var second = box.Value; // @goto value @known-gap receiver-property-goto observed=not_found
            var indexed = box[0]; // indexer access
            CoreBox.Node nested = new(); // @ref node @known-gap nested-type observed=none
            nested.Id = Build(4); // @ref id @known-gap nested-member observed=none
            var built = Build(4); // @ref build
            var tag = box.Tag(); // @ref tag @known-gap extension-method observed=none
            var tagGoto = box.Tag(); // @goto tag @known-gap extension-goto observed=not_found
            var extra = box.Extra; // @ref extra @known-gap partial-member observed=none
            var extraGoto = box.Extra; // @goto extra @known-gap partial-member-goto observed=not_found
            var echoed = box.Echo("x"); // @ref echo @known-gap partial-method observed=none
            var escaped = new @class(); // @ref escaped
            var escapedGoto = new @class(); // @goto escaped
            var decoy = "Value Box Build Tag";
            var verbatim = @"Value Box Build Tag";
            var raw = """Value Box Build Tag"""; // @not-ref value @not-ref build @not-ref node @not-ref extra
            var interpolated = $"Value {box.Value} Box Build Tag"; // @ref value @known-gap interpolated-receiver-property observed=none
            var decoyComment = 0; // Value Box Build Tag are comment-only decoys. @not-ref value
            return Build(first.Length + nested.Id); // @ref build
        }
    }
}
