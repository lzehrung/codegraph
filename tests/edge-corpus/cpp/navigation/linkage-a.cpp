static int run() { return 1; } // @def localRunA=run @coverage localRunA complete

int call_a() { return run(); } // @ref localRunA @goto localRunA=run @not-ref localRunB
