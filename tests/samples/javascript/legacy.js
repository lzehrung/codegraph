// Legacy CommonJS module
function legacyFunction() {
  return "Legacy CommonJS function";
}

class LegacyClass {
  constructor() {
    this.value = "legacy";
  }
}

module.exports = {
  legacyFunction,
  LegacyClass,
};

// Also export individual items
module.exports.legacyFunction = legacyFunction;
module.exports.LegacyClass = LegacyClass;
