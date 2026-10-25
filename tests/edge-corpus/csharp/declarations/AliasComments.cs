namespace Edge.Commented
{
    using X /* ; */ = Edge.Core;

    public class AliasComments
    {
        public X.Point Use() => default; // @goto point=Point @known-gap commented_alias_goto observed=not_found
    }
}
