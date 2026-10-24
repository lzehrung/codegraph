<?php
namespace App\Model;

trait HasLabel
{
    // @def label
    public function label(): string { return $this->name; } // @ref name @known-gap trait-promoted-property observed=none
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
    use HasLabel;

    public function __construct(public string $name, private int $count = 0) {} // @def name @def count

    public function describe(): string
    {
        $current = $this;
        $current->label(); // @ref label @known-gap trait-receiver-reference observed=none
        $current->label(); // @goto label @known-gap trait-receiver-goto observed=not_found
        $parentValue = $this->inherited(); // @ref inherited @goto inherited
        $fromSelf = self::factory(); // @ref factory @goto factory
        $fromParentReference = parent::factory(); // @ref factory @known-gap parent-static-reference observed=none
        $fromParentGoto = parent::factory(); // @goto factory @known-gap parent-static-goto observed=not_found
        $fromLateStatic = static::factory(); // @ref factory @goto factory
        $name = $this->name; // @ref name
        $count = $this->count; // @ref count
        return $parentValue . $fromSelf->name . $fromParentReference->name . $fromParentGoto->name . $fromLateStatic->name . $name . $count;
    }
}
