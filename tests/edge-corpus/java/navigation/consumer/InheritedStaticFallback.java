package consumer;

import api.Service;
import static api.Extra.pick;

class InheritedStaticFallback extends Service {
    int run() {
        return pick(1, 2); // @not-ref staticPick
    }
}
