<?php
namespace App\CaseRules;

// @def Widget
class Widget {}

// @def render
function render(): string { return 'ok'; }
const SETTINGS = 'strict'; // @def settings=SETTINGS
interface ApiContract {} // @def apiContract=ApiContract
enum Stage { case Ready; } // @def stage=Stage
class ContractConsumer implements aPICONTRACT { public function take(sTaGe $value): sTaGe { return $value; } } // @ref apiContract @goto apiContract=aPICONTRACT @ref stage
function useStage() { return sTaGe::Ready; } // @goto stage=sTaGe
function constants() { $decoy = 'SETTINGS'; return settings; } // @not-ref settings
function exercise(): string
{
    $Value = 'upper'; // @def Value
    $value = 'lower'; /* Value */ // @not-ref Value
    $sameVariable = $VALUE; /* Value */
    $class = new wIDGET(); // @ref Widget @goto Widget=wIDGET
    $one = RENDER(); // @goto render=RENDER @known-gap case-insensitive-function-goto observed=not_found
    return $Value . $value . $sameVariable . get_class($class) . $one;
}
