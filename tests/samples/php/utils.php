<?php

namespace App\Utils;

class UtilityClass
{
    public static function create(): self
    {
        return new self();
    }
}

function helper_function(): string
{
    return 'ok';
}
