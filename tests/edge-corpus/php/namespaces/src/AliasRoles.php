<?php
namespace App\AliasClient;

use App\Library\Gadget as Alias;
use function App\Library\normalize as alias;
use const App\Library\MODE as alias;

function exercise(): string
{
    $object = new ALIAS(); // @ref gadget @goto gadget=ALIAS
    $normalized = alias("value"); // @ref normalize @goto normalize=alias
    $setting = alias; // @ref mode @goto mode=alias
    return $object->name() . $normalized . $setting;
}
