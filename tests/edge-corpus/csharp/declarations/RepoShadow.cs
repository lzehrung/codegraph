namespace Decoy
{
    public class Repo
    {
        public int Find() => 1; // @def decoyFind=Find
    }
}

namespace External
{
    using Decoy;

    public class Host<Repo>
    {
        public Repo repo = default!;
        public int Run() => this.repo.Find(); // @not-ref decoyFind
    }
}
