<?php

class PropertyHolder
{
    public int $count;
    public $label;
    public static $shared;

    public function read(): string
    {
        return $this->count . $this->label . self::$shared;
    }
}
