package sample;

import sample.pkg.*;

public class WildcardImports {
  PackageTypes.NestedValue value = new PackageTypes.NestedValue();
  ServiceContract contract = () -> {};
  PackageService service = () -> {};
  Mode mode = Mode.FAST;
}
