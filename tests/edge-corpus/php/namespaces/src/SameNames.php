<?php
namespace App\FirstBox;

class Box { // @def firstBox=Box
    public function run(): string { return 'first'; } // @def firstRun=run
}

namespace App\SecondBox;

class Box { // @def secondBox=Box
    public function run(): string { return 'second'; } // @def secondRun=run
}

namespace App\UsesBox;

function useSecond(): string
{
    $box = new \App\SecondBox\Box(); // @goto secondBox=Box @known-gap namespace_class_goto observed=not_found
    return $box->RUN(); // @ref secondRun
    return $box->RUN(); // @goto secondRun=RUN @known-gap case_variant_method_goto observed=not_found
}
