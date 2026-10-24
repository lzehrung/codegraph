<?php
namespace App\CaseRules;

// @def Widget
class Widget {}

// @def render
function render(): string { return 'ok'; }

function exercise(): string
{
    $Value = 'upper'; // @def Value
    $value = 'lower'; // @not-ref Value
    $sameVariable = $VALUE; // @not-ref Value
    $class = new wIDGET(); // @ref Widget @goto Widget
    $one = RENDER(); // @goto render @known-gap case-insensitive-function-goto observed=not_found
    return $Value . $value . $sameVariable . get_class($class) . $one;
}
