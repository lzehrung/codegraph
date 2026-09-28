namespace named { int isolated() { return 1; } }
int invalid_bare() { return isolated(); }
int valid_qualified() { return named::isolated(); }
