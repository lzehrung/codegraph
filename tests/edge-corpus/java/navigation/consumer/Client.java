package consumer;

import api.Service; // @ref Service @goto Service
import api.*;
import static api.Mode.ACTIVE; // @ref ACTIVE @goto ACTIVE
import static api.Extra.utility;

@Marker // @ref Marker @goto Marker
class Client extends Service {
    String run() {
        Service service = new Service();
        service.send("text"); // @not-ref sendText @not-ref sendNumber
        service.send(3); // @not-ref sendText @not-ref sendNumber
        String echoed = service.echo("generic"); // @ref echo @goto echo
        var nested = new Service.Nested(); // @ref Nested @goto Nested
        var inner = service.new Inner(); // @ref Inner @known-gap inner-constructor-reference observed=none
        service.new Inner(); // @goto Inner @known-gap inner-constructor-goto observed=not_found
        Service innerOwner = inner.owner();
        Mode mode = ACTIVE; // @ref ACTIVE @goto ACTIVE
        int codeValue = mode.code(); // @ref code @goto code
        String util = utility(); // @ref utility @goto utility
        String star = new Extra().toString(); // @ref Extra @goto Extra
        String samePackage = LocalPeer.pick(); // @ref LocalPeer @goto LocalPeer @ref pick @goto pick
        Named named = service; // @ref Named @goto Named
        String labelText = named.label(); // @ref label @goto label
        String inherited = super.baseTag(); // @ref baseTag @goto baseTag
        return echoed + nested.name() + innerOwner + codeValue + util + star + samePackage + labelText + inherited;
    }

    @Override
    public String toString() { return super.toString(); }

    String decoys() {
        // Service send echo Nested Inner ACTIVE Marker utility are decoys here.
        String text = "Service.send(echo) Nested Inner ACTIVE Marker utility"; // @not-ref Service @not-ref echo
        // @not-ref-block Service @not-ref-block echo
        String block = """
                Service.send(echo) Nested Inner ACTIVE Marker utility
                """;
        return text + block;
    }
}
