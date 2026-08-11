<?php

interface EnumContract
{
    public function label(): string;
}

enum EnumStatus implements EnumContract
{
    case Ready;

    public function label(): string
    {
        return "ready";
    }
}
