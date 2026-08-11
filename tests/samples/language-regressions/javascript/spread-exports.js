const base = require("./spread-base");

function localFunction() {
  return "local";
}

const local = { localFunction };
const dynamic = getDynamicExports();

module.exports = { ...base, ...local, ...dynamic };
