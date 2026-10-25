<?php
namespace App\Client;

use App\Library\Gadget as Tool; // @ref gadget
use function App\Library\normalize as clean; // @ref normalize
use const App\Library\MODE as DEFAULT_MODE; // @ref mode

#[\aPP\lIBRARY\rOuTe] // @ref route @goto route=rOuTe
class Marked {}

// @def clientHelper=Helper
function Helper(): string { return 'client'; }

function run(): string
{
    $tool = new tOoL(); // @ref gadget @goto gadget=tOoL
    $upperTool = new \aPP\lIBRARY\gAdGeT(); // @ref gadget @goto gadget=gAdGeT
    $methodName = $tool->NAME(); // @ref gadgetName @goto gadgetName=NAME
    $typed = function (Tool $item) { return $item; }; // @ref gadget @goto gadget=Tool
    $normalized = clean('MiXeD'); // @ref normalize @goto normalize=clean
    $again = CLEAN('UPPER'); // @ref normalize
    $qualified = \aPP\lIBRARY\nOrMaLiZe('Qualified'); // @ref normalize
    $option = DEFAULT_MODE; // @ref mode @goto mode=DEFAULT_MODE
    $lowerOption = default_mode; /* MODE */ // @not-ref mode
    $text = 'Gadget Tool clean DEFAULT_MODE'; // @not-ref gadget
    // Gadget clean DEFAULT_MODE are comment decoys. @not-ref-block normalize @not-ref-block mode
    $heredoc = <<<TEXT
Gadget normalize MODE
TEXT;
    // @not-ref-block gadget
    $nowdoc = <<<'TEXT'
Gadget normalize MODE
TEXT;
    $client = HELPER(); // @ref clientHelper @not-ref globalHelper
    return $tool->NAME() . $upperTool->name() . $methodName . $normalized . $again . $qualified . $option . $text . $heredoc . $nowdoc . $client;
}
