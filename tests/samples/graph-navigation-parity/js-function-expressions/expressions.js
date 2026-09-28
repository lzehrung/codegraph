function g() { return 1; }
var f = function () { return g(); };
var h = function named() { return g(); };
function outer() {
  var inner = function () { return g(); };
  [1].forEach(function (x) { g(); });
  var obj = { value: function m() { return g(); } };
  return inner() + obj.value();
}
exports.k = function () { return g(); };
var C = (function (base) {
  function C() { base(); }
  var proto = { key: "m", value: function m() { return g(); } };
  return C;
})(g);
