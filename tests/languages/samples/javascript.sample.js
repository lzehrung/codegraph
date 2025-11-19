// Top comment about Foo

import fs from "fs";

const API_BASE_URL = "https://example.com";

class Foo {
  constructor(id) {
    this.id = id;
  }

  bar(x) {
    if (x > 0) {
      return x;
    }
    return -x;
  }
}

// standalone function
function baz(y) {
  return y * 2;
}

