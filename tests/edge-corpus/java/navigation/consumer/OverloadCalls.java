package consumer;

import api.Service;

class OverloadCalls extends Service
{
    int inheritedPick() { return choose(1); } // @not-ref baseChoose @not-ref intChoose
    int typeReceiver() { return Service.mix(1); } // @goto staticMix=mix
}
