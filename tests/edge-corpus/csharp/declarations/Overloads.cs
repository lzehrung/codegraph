namespace Edge.Inheritance
{
    public class Base
    {
        public virtual int Pick(int value = 0) => value; // @def baseOptional=Pick
        public int Pick(int first, int second) => first + second; // @def basePair=Pick
    }

    public class Derived : Base
    {
        public override int Pick(int value) => value; // @def overloadDerivedPick=Pick
        public int InvalidArity() => Pick(); // @not-ref baseOptional @not-ref basePair
        public int ValidPair() => Pick(1, 2); // @ref basePair @goto basePair=Pick
    }
}
