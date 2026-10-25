package consumer;

import api.PackageLocal;
import api.Service;

class Visibility extends Service
{
    int call() {
        int hidden = new PackageLocal().value(); // @not-ref packageValue
        return super.baseTag().length(); // @ref baseTag @goto baseTag
    }
}
