<?php

namespace App\Core;

const APP_MODE = 'test';

enum AppMode
{
    case Test;
    case Prod;
}

class UtilityClass
{
    public function run(): string
    {
        return helper_function();
    }
}

function helper_function(): string
{
    return APP_MODE;
}
