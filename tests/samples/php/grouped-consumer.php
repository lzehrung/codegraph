<?php

include './helpers.php';
include_once './partials/shared.php';

use aPp\sUpPoRt\{tOoLbOx as SupportToolbox, function SuPpOrT_hElPeR, const DEFAULT_NAME};

$tool = SupportToolbox::make();
$value = support_helper(DEFAULT_NAME);
echo helper_from_helpers();
echo include_only_helper();
