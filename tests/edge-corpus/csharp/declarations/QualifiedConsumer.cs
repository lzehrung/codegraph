using static Edge.Core.Helpers;

namespace Foreign.Client
{
    public class QualifiedConsumer
    {
        public int Run() => Edge.Core.Helpers.Build(8); // @ref build @goto build
    }
    public class PrivateBuildBase
    {
        private int Build(int value) => value; // @def privateBuild=Build
    }

    public class PrivateBuildDerived : PrivateBuildBase
    {
        public int Run() => Build(4); // @ref build @known-gap private_base_static_using_reference observed=none
        public int RunAgain() => Build(4); // @goto build=Build @known-gap private_base_static_using_goto observed=not_found
    }
}
