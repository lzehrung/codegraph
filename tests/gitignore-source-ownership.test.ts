import { describe, expect, it } from "vitest";
import {
  createGitIgnoreSourceOwnershipLookup,
  owningGitIgnoreSourceRoot,
  type GitIgnoreSourceRoot,
} from "../src/util/projectFiles.js";

const superproject: GitIgnoreSourceRoot = {
  path: "C:/Game/Source",
  repositoryRoot: "C:/Game/Source",
};
const submodule: GitIgnoreSourceRoot = {
  path: "C:/Game/Source/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Game/Source/Plugins/AmazonGameLift",
};
const shortAlias: GitIgnoreSourceRoot = {
  path: "C:/Game/Source/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Game/Source",
};
const longAlias: GitIgnoreSourceRoot = {
  path: "C:/Game/Source/Plugins/AmazonGameLift",
  repositoryRoot: "C:/Game/Source/Plugins/AmazonGameLift",
};

describe("Git ignore source ownership", () => {
  it("attributes candidates inside and outside a nested submodule", () => {
    const outside = "C:/Game/Source/Runtime/Foo.cpp";
    const inside = "C:/Game/Source/Plugins/AmazonGameLift/Source/Bar.cpp";
    const roots = [superproject, submodule];

    expect(owningGitIgnoreSourceRoot(outside, roots)).toEqual(superproject);
    expect(owningGitIgnoreSourceRoot(inside, roots)).toEqual(submodule);
  });

  it("prefers the root with the longer repositoryRoot when both contain the candidate", () => {
    const file = "C:/Game/Source/Plugins/AmazonGameLift/Source/Bar.cpp";

    expect(owningGitIgnoreSourceRoot(file, [shortAlias, longAlias])).toEqual(longAlias);
    expect(owningGitIgnoreSourceRoot(file, [longAlias, shortAlias])).toEqual(longAlias);
  });

  it("does not reuse ownership memos across discovery passes", () => {
    const inside = "C:/Game/Source/Plugins/AmazonGameLift/Source/Bar.cpp";
    const firstPass = createGitIgnoreSourceOwnershipLookup([superproject, submodule]);
    const secondPass = createGitIgnoreSourceOwnershipLookup([superproject]);

    expect(firstPass(inside)).toEqual(submodule);
    expect(secondPass(inside)).toEqual(superproject);
    expect(firstPass(inside)).toEqual(submodule);
  });
});
