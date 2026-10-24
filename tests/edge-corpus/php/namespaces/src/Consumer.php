<?php
namespace App\Client;

use App\Library\Gadget as Tool; // @ref gadget
use function App\Library\normalize as clean; // @ref normalize
use const App\Library\MODE as DEFAULT_MODE; // @ref mode

function run(): string
{
    $tool = new Tool(); // @ref gadget @goto gadget=Tool
    $typed = function (Tool $item) { return $item; }; // @ref gadget @goto gadget=Tool
    $normalized = clean('MiXeD'); // @ref normalize @goto normalize=clean
    $again = CLEAN('UPPER'); // @ref normalize
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
    return $tool->name() . $normalized . $again . $option . $text . $heredoc . $nowdoc;
}
