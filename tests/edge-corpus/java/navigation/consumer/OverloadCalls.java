package consumer;

import api.Service;

class OverloadCalls extends Service
{
    int inheritedPick() { return choose(1); } // @goto intChoose=choose @known-gap inherited_overload_goto observed=not_found
    int typeReceiver() { return Service.mix(1); } // @goto staticMix=mix
}
