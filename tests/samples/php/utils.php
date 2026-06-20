<?php

namespace App\Utils;

class UtilityClass
{
    public static function create(): self
    {
        return new self();
    }
}

enum UtilityMode
{
    case Fast;
    case Slow;
}

function helper_function(): string
{
    return 'ok';
}
