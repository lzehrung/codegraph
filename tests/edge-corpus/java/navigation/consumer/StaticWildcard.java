package consumer;

import static api.Extra.*;

class StaticWildcard
{
    int call() { return pick(1, 2); } // @ref staticPick @goto staticPick=pick
}
