<?php
namespace App\Library;

// @def gadget=Gadget @coverage gadget complete
class Gadget
{
    public function name(): string { return 'gadget'; }
}

// @def normalize @coverage normalize complete
function normalize(string $value): string { return strtolower($value); }

// @def mode=MODE @coverage mode complete
const MODE = 'strict';
