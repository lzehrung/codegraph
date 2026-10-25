namespace A
{
    public class Repo
    {
        public int Find() => 1; // @def aFind=Find
    }
}

namespace B
{
    public class Repo
    {
        public int Find() => 2; // @def bFind=Find
    }
}

namespace A
{
    public class Host
    {
        private B.Repo repo = new();
        public int Run() => this.repo.Find(); // @goto bFind=Find @known-gap field_receiver_member_goto observed=not_found
    }
}
