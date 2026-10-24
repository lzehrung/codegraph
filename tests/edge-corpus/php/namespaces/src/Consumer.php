<?php
namespace App\Client;

use App\Library\Gadget as Tool; // @ref gadget
use function App\Library\normalize as clean; // @ref normalize
use const App\Library\MODE as DEFAULT_MODE; // @ref mode

function run(): string
{
    $tool = new Tool(); // @ref gadget @goto gadget
    $typed = function (Tool $item): Tool { return $item; }; // @ref gadget @goto gadget
    $normalized = clean('MiXeD'); // @ref normalize @goto normalize
    $again = CLEAN('UPPER'); // @ref normalize
    $option = DEFAULT_MODE; // @ref mode @goto mode
    $lowerOption = default_mode; // @not-ref mode
    $text = 'Gadget Tool clean DEFAULT_MODE'; // @not-ref gadget
    // Gadget clean DEFAULT_MODE are comment decoys. @not-ref normalize
    $heredoc = <<<TEXT
Gadget normalize MODE
TEXT; // @not-ref mode
    $nowdoc = <<<'TEXT'
Gadget normalize MODE
TEXT; // @not-ref gadget
    return $tool->name() . $normalized . $again . $option . $text . $heredoc . $nowdoc;
}
