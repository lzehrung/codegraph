var EE = function () {};
function check(x) { return x; }
function handleMove() { return 0; }
EE.prototype.once = function once2(t) { check(t); return this; };
exports.getter = function (n) { return check(n); };
function bind() {
  this.listeners = {};
  this.listeners.handleMove = function (e) { return check(e); };
}
