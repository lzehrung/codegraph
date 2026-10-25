#include "cross-file-overload.hpp"
int use() { return crossPick(1); } // @goto crossPickOne=crossPick @not-ref crossPickTwo
//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
