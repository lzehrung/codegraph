package app;

import geo.Point;
import helpers.Helpers;
import unicode.Café;
import utils.Utils;

public class Consumer {
  public static int run() {
    Utils.helperFunction();
    Helpers.helperFromHelpers();
    Café.value();
    new Utils.UtilityClass();
    Point point = new Point(1, 2);
    return point.hashCode();
  }
}
