<?php
namespace App\CaseRules;

// @def Widget
class Widget {}

// @def render
function render(): string { return 'ok'; }

function exercise(): string
{
    $Value = 'upper'; // @def Value
    $value = 'lower'; /* Value */ // @not-ref Value
    $sameVariable = $VALUE; /* Value */ // @not-ref Value
    $class = new wIDGET(); // @ref Widget @goto Widget=wIDGET
    $one = RENDER(); // @goto render=RENDER @known-gap case-insensitive-function-goto observed=not_found
    return $Value . $value . $sameVariable . get_class($class) . $one;
}
