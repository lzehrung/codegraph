<?php

namespace App\Domain;

class Service
{
    public const NAME = 'service';

    public static string $shared = 'shared';

    public static function make(): self
    {
        return new self();
    }

    public static function fromQualified(self $service): self
    {
        return $service;
    }

    public function run(): string
    {
        return self::NAME;
    }
}
