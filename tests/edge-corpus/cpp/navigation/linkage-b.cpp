static int run() { return 2; } // @def localRunB=run @coverage localRunB complete

int call_b() { return run(); } // @ref localRunB @goto localRunB=run @not-ref localRunA
