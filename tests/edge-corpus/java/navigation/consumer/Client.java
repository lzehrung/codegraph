package consumer;

import api.Service; // @ref Service @goto Service
import api.*;
import static api.Mode.ACTIVE; // @ref ACTIVE @goto ACTIVE
import static api.Extra.utility;

@Marker // @ref Marker @goto Marker
class Client extends Service {
    String run() {
        Service service = new Service();
        service.send("text"); // @ref sendText @known-gap overload_call_reference_missing observed=none
        service.send(3); // @ref sendNumber @known-gap overload_call_reference_missing observed=none
        String echoed = service.echo("generic"); // @ref echo @goto echo
        Service.Nested nested = new Service.Nested(); // @ref Nested @goto Nested
        Service.Inner inner = service.new Inner(); // @ref Inner @goto Inner
        String innerOwner = inner.owner();
        Mode mode = ACTIVE; // @ref ACTIVE @goto ACTIVE
        int code = mode.code(); // @ref code @goto code
        String util = utility(); // @ref utility @goto utility
        String star = new Extra().toString(); // @ref Extra @goto Extra
        String samePackage = LocalPeer.pick(); // @ref LocalPeer @goto LocalPeer @ref pick @goto pick
        Named named = service; // @ref Named @goto Named
        String label = named.label(); // @ref label @goto label
        String inherited = super.baseTag(); // @ref baseTag @goto baseTag
        return echoed + nested.name() + innerOwner + code + util + star + samePackage + label + inherited;
    }

    @Override
    public String toString() { return super.toString(); }

    String decoys() {
        // Service send echo Nested Inner ACTIVE Marker utility are decoys here.
        String text = "Service.send(echo) Nested Inner ACTIVE Marker utility";
        String block = """
                Service.send(echo) Nested Inner ACTIVE Marker utility
                """;
        return text + block;
    }
}
