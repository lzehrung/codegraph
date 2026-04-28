<?php

require_once './utils.php';
require './helpers.php';

use App\Utils\UtilityClass;
use function App\Utils\helper_function;

$result = helper_function();
$utility = UtilityClass::create();
echo helper_from_helpers();
