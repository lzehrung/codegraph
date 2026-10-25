<?php
namespace App\AnotherClient;

function run(): string
{
    $global = HELPER(); // @ref globalHelper
    return $global;
}
