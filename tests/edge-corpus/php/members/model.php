<?php
namespace App\Model;

// @def hasLabel=HasLabel
trait HasLabel
{
    // @def label
    public function label(): string { return $this->name; } // @ref name
}

class ParentRecord
{
    // @def factory
    public static function factory(): static { return new static(); }

    // @def inherited
    protected function inherited(): string { return 'parent'; }
}

class Record extends ParentRecord
{
    use hASlABEL; // @ref hasLabel @goto hasLabel=hASlABEL

    public function __construct(public string $name, private int $count = 0) {} // @def name @def count

    public function describe(): string
    {
        $obj = new Record('constructed');
        $this->label(); // @ref label
        $obj->label(); // @goto label
        $parentValue = $this->inherited(); // @ref inherited @goto inherited
        $fromSelf = self::factory(); // @ref factory @goto factory
        $fromParentReference = parent::factory(); // @ref factory
        $fromParentGoto = parent::factory(); // @goto factory
        $fromLateStatic = static::factory(); // @ref factory @goto factory
        $name = $this->name; // @ref name
        $count = $this->count; // @ref count
        return $parentValue . $fromSelf->name . $fromParentReference->name . $fromParentGoto->name . $fromLateStatic->name . $name . $count;
    }
}
