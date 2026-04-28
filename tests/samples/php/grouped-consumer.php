<?php

include './helpers.php';
include_once './partials/shared.php';

use App\Support\{Toolbox as SupportToolbox, function support_helper, const DEFAULT_NAME};

$tool = SupportToolbox::make();
$value = support_helper(DEFAULT_NAME);
echo helper_from_helpers();
echo include_only_helper();
