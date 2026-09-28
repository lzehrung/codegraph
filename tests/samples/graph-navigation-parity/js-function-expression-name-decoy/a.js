function target() { return 1; }
function render() { return 0; }
function outer() {
  var obj = { value: function render() { return target(); } };
  return obj;
}
