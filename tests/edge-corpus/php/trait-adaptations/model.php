<?php
trait A
{
    // @def aShared=shared
    public function shared(): string { return 'A'; }
    // @def aOther=other
    public function other(): string { return 'A'; }
    // @def aOnly=only
    public function only(): string { return 'A'; }
}

trait B
{
    public function shared(): string { return 'B'; }
}

class Base
{
    // @def baseShared=shared
    public function shared(): string { return 'base'; }
    // @def baseOther=other
    public function other(): string { return 'base'; }
    // @def baseAlt=alt
    public function alt(): string { return 'base'; }
}

class Unrelated extends Base
{
    use A { A::shared as alt; }
    public function run(): string
    {
        $otherValue = $this->other(); // @ref aOther @goto aOther @not-ref baseOther
        $onlyValue = $this->only(); // @ref aOnly @goto aOnly
        $sharedValue = $this->shared(); // @ref aShared @goto aShared @not-ref baseShared
        $alias = $this->alt(); // @not-ref baseAlt
        return $otherValue . $onlyValue . $alias . $sharedValue;
    }
}

class Record extends Base
{
    use A, B { A::shared insteadof B; B::shared as alt; }
}

class Child extends Record
{
    public function child(): string
    {
        $shared = $this->shared(); // @not-ref baseShared
        $parentShared = parent::shared(); // @not-ref baseShared
        $otherValue = parent::other(); // @ref aOther @goto aOther @not-ref baseOther
        return $shared . $parentShared . $otherValue;
    }
}

trait Requirement
{
    // @def request
    abstract public function request(): string;
    public function get(): string
    {
        return $this->request(); // @ref request @goto request
    }
}

class Implementation
{
    use Requirement;
    public function request(): string { return 'implemented'; }
}
