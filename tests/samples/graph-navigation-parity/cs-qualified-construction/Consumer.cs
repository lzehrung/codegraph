using UtilsClass = Library.UtilsClass;
using X = AliasSpace;

namespace App;

public class Consumer {
  public void Make() {
    _ = new UtilsClass.UtilityClass();
    _ = new NS.Point();
    _ = new X::Outer.Inner();
  }
}
