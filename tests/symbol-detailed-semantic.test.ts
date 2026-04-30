import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildSymbolGraphDetailed } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

const normalizePath = (p: string): string => p.replace(/\\/g, "/");

describe("Detailed symbol graph (semantic edges)", () => {
  it("adds calls edges for local functions", async () => {
    const root = await mkTmpDir("dg-calls-local-");
    const main = `
export function a(): number { return b(); }
export function b(): number { return 1; }
`;
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const aDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "a");
    const bDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "b");
    expect(aDef).toBeDefined();
    expect(bDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === aDef?.id && e.to === bDef?.id && e.label === "calls");
    expect(edge).toBeDefined();
  });

  it("adds calls edges for imported functions", async () => {
    const root = await mkTmpDir("dg-calls-import-");
    const util = `export function helper(): number { return 1; }\n`;
    const main = `import { helper } from "./util";\nexport function uses(): number { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const helperDef = nodes.find((n) => n.file.endsWith("/util.ts") && n.name === "helper");
    const usesDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "uses");
    expect(helperDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === usesDef?.id && e.to === helperDef?.id && e.label === "calls");
    expect(edge).toBeDefined();
  });

  it("adds extends and implements edges for classes", async () => {
    const root = await mkTmpDir("dg-class-edges-");
    const types = `export interface IShape { area(): number }\n`;
    const main = `
import { IShape } from "./types";
export class BaseShape {}
export class Square extends BaseShape implements IShape {
  area(): number { return 1; }
}
`;
    await fsp.writeFile(path.join(root, "types.ts"), types, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const baseDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "BaseShape");
    const squareDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "Square");
    const ifaceDef = nodes.find((n) => n.file.endsWith("/types.ts") && n.name === "IShape");
    expect(baseDef).toBeDefined();
    expect(squareDef).toBeDefined();
    expect(ifaceDef).toBeDefined();

    const extendsEdge = sg.edges.find((e) => e.from === squareDef?.id && e.to === baseDef?.id && e.label === "extends");
    const implementsEdge = sg.edges.find((e) => e.from === squareDef?.id && e.to === ifaceDef?.id && e.label === "implements");
    expect(extendsEdge).toBeDefined();
    expect(implementsEdge).toBeDefined();
  });

  it("adds instantiates edges for new expressions", async () => {
    const root = await mkTmpDir("dg-instantiates-");
    const main = `
export class Widget {}
export function make() { return new Widget(); }
`;
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const widgetDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "Widget");
    const makeDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "make");
    expect(widgetDef).toBeDefined();
    expect(makeDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === makeDef?.id && e.to === widgetDef?.id && e.label === "instantiates");
    expect(edge).toBeDefined();
  });

  it("adds instantiates edges for namespace-qualified constructors", async () => {
    const root = await mkTmpDir("dg-instantiates-ns-");
    const lib = `export class Gizmo {}`;
    const main = `
import * as Lib from "./lib";
export function make() { return new Lib.Gizmo(); }
`;
    await fsp.writeFile(path.join(root, "lib.ts"), lib, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const gizmoDef = nodes.find((n) => n.file.endsWith("/lib.ts") && n.name === "Gizmo");
    const makeDef = nodes.find((n) => n.file.endsWith("/main.ts") && n.name === "make");
    expect(gizmoDef).toBeDefined();
    expect(makeDef).toBeDefined();

    const edge = sg.edges.find((e) => e.from === makeDef?.id && e.to === gizmoDef?.id && e.label === "instantiates");
    expect(edge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: Java)", () => {
  it("adds extends, implements, calls, and instantiates edges", async () => {
    const root = await mkTmpDir("dg-java-se-");
    const main = `
public class App extends Base implements Service {
  public void run() { helper(); new Thing(); }
}
interface Service { void run(); }
class Base { void helper() {} }
class Thing {}
`;
    await fsp.writeFile(path.join(root, "App.java"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const appDef = nodes.find((n) => n.file.endsWith("/App.java") && n.name === "App");
    const baseDef = nodes.find((n) => n.file.endsWith("/App.java") && n.name === "Base");
    const serviceDef = nodes.find((n) => n.file.endsWith("/App.java") && n.name === "Service");
    const helperDef = nodes.find((n) => n.file.endsWith("/App.java") && n.name === "helper");
    const runDef = nodes.find((n) => n.file.endsWith("/App.java") && n.name === "run");
    const thingDef = nodes.find((n) => n.file.endsWith("/App.java") && n.name === "Thing");
    expect(appDef).toBeDefined();
    expect(baseDef).toBeDefined();
    expect(serviceDef).toBeDefined();
    expect(helperDef).toBeDefined();
    expect(runDef).toBeDefined();
    expect(thingDef).toBeDefined();

    const extendsEdge = sg.edges.find((e) => e.from === appDef?.id && e.to === baseDef?.id && e.label === "extends");
    const implementsEdge = sg.edges.find((e) => e.from === appDef?.id && e.to === serviceDef?.id && e.label === "implements");
    const callsEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === helperDef?.id && e.label === "calls");
    const instantiatesEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === thingDef?.id && e.label === "instantiates");
    expect(extendsEdge).toBeDefined();
    expect(implementsEdge).toBeDefined();
    expect(callsEdge).toBeDefined();
    expect(instantiatesEdge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: C#)", () => {
  it("adds extends, implements, calls, and instantiates edges", async () => {
    const root = await mkTmpDir("dg-cs-se-");
    const main = `
public class App : Base, IService {
  public void Run() { Helper(); new Widget(); }
}
public interface IService { void Run(); }
public class Base { public void Helper() {} }
public class Widget {}
`;
    await fsp.writeFile(path.join(root, "App.cs"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const appDef = nodes.find((n) => n.file.endsWith("/App.cs") && n.name === "App");
    const baseDef = nodes.find((n) => n.file.endsWith("/App.cs") && n.name === "Base");
    const serviceDef = nodes.find((n) => n.file.endsWith("/App.cs") && n.name === "IService");
    const helperDef = nodes.find((n) => n.file.endsWith("/App.cs") && n.name === "Helper");
    const runDef = nodes.find((n) => n.file.endsWith("/App.cs") && n.name === "Run");
    const widgetDef = nodes.find((n) => n.file.endsWith("/App.cs") && n.name === "Widget");
    expect(appDef).toBeDefined();
    expect(baseDef).toBeDefined();
    expect(serviceDef).toBeDefined();
    expect(helperDef).toBeDefined();
    expect(runDef).toBeDefined();
    expect(widgetDef).toBeDefined();

    const extendsEdge = sg.edges.find((e) => e.from === appDef?.id && e.to === baseDef?.id && e.label === "extends");
    const implementsEdge = sg.edges.find((e) => e.from === appDef?.id && e.to === serviceDef?.id && e.label === "implements");
    const callsEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === helperDef?.id && e.label === "calls");
    const instantiatesEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === widgetDef?.id && e.label === "instantiates");
    expect(extendsEdge).toBeDefined();
    expect(implementsEdge).toBeDefined();
    expect(callsEdge).toBeDefined();
    expect(instantiatesEdge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: Go)", () => {
  it("adds calls and instantiates edges", async () => {
    const root = await mkTmpDir("dg-go-se-");
    const main = `
package main

type Widget struct{}

func helper() {}

func run() {
  helper()
  _ = Widget{}
  _ = new(Widget)
}
`;
    await fsp.writeFile(path.join(root, "main.go"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const runDef = nodes.find((n) => n.file.endsWith("/main.go") && n.name === "run");
    const helperDef = nodes.find((n) => n.file.endsWith("/main.go") && n.name === "helper");
    const widgetDef = nodes.find((n) => n.file.endsWith("/main.go") && n.name === "Widget");
    expect(runDef).toBeDefined();
    expect(helperDef).toBeDefined();
    expect(widgetDef).toBeDefined();

    const callsEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === helperDef?.id && e.label === "calls");
    const instantiatesEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === widgetDef?.id && e.label === "instantiates");
    expect(callsEdge).toBeDefined();
    expect(instantiatesEdge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: Rust)", () => {
  it("adds implements, calls, and instantiates edges", async () => {
    const root = await mkTmpDir("dg-rust-se-");
    const main = `
trait IService { fn run(&self); }
struct App;
struct Thing;

fn helper() {}

impl IService for App {
  fn run(&self) {
    helper();
    let _x = Thing{};
  }
}
`;
    await fsp.writeFile(path.join(root, "main.rs"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const appDef = nodes.find((n) => n.file.endsWith("/main.rs") && n.name === "App");
    const serviceDef = nodes.find((n) => n.file.endsWith("/main.rs") && n.name === "IService");
    const runDef = nodes.find((n) => n.file.endsWith("/main.rs") && n.name === "run");
    const helperDef = nodes.find((n) => n.file.endsWith("/main.rs") && n.name === "helper");
    const thingDef = nodes.find((n) => n.file.endsWith("/main.rs") && n.name === "Thing");
    expect(appDef).toBeDefined();
    expect(serviceDef).toBeDefined();
    expect(runDef).toBeDefined();
    expect(helperDef).toBeDefined();
    expect(thingDef).toBeDefined();

    const implementsEdge = sg.edges.find((e) => e.from === appDef?.id && e.to === serviceDef?.id && e.label === "implements");
    const callsEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === helperDef?.id && e.label === "calls");
    const instantiatesEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === thingDef?.id && e.label === "instantiates");
    expect(implementsEdge).toBeDefined();
    expect(callsEdge).toBeDefined();
    expect(instantiatesEdge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: Ruby)", () => {
  it("adds calls and instantiates edges", async () => {
    const root = await mkTmpDir("dg-ruby-se-");
    const main = `
class Widget
end

class App
  def helper
  end

  def run
    helper()
    Widget.new
  end
end
`;
    await fsp.writeFile(path.join(root, "main.rb"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const runDef = nodes.find((n) => n.file.endsWith("/main.rb") && n.name === "run");
    const helperDef = nodes.find((n) => n.file.endsWith("/main.rb") && n.name === "helper");
    const widgetDef = nodes.find((n) => n.file.endsWith("/main.rb") && n.name === "Widget");
    expect(runDef).toBeDefined();
    expect(helperDef).toBeDefined();
    expect(widgetDef).toBeDefined();

    const callsEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === helperDef?.id && e.label === "calls");
    const instantiatesEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === widgetDef?.id && e.label === "instantiates");
    expect(callsEdge).toBeDefined();
    expect(instantiatesEdge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: Python)", () => {
  it("adds decorates edges for stacked decorators", async () => {
    const root = await mkTmpDir("dg-py-deco-stack-");
    const main = `
def first(fn):
    return fn

def second(fn):
    return fn

@first
@second
def run():
    return 1
`;
    await fsp.writeFile(path.join(root, "__init__.py"), "", "utf8");
    await fsp.writeFile(path.join(root, "main.py"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const firstDef = nodes.find((n) => n.file.endsWith("/main.py") && n.name === "first");
    const secondDef = nodes.find((n) => n.file.endsWith("/main.py") && n.name === "second");
    const runDef = nodes.find((n) => n.file.endsWith("/main.py") && n.name === "run");
    expect(firstDef).toBeDefined();
    expect(secondDef).toBeDefined();
    expect(runDef).toBeDefined();

    const firstEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === firstDef?.id && e.label === "decorates");
    const secondEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === secondDef?.id && e.label === "decorates");
    expect(firstEdge).toBeDefined();
    expect(secondEdge).toBeDefined();
  });
});

describe("Detailed symbol graph (semantic edges: Vue/Svelte)", () => {
  it("handles Vue script blocks for calls and instantiates edges", async () => {
    const root = await mkTmpDir("dg-vue-se-");
    const component = `
<script>
export class Widget {}
export function run() {
  new Widget();
}
</script>
`;
    await fsp.writeFile(path.join(root, "Component.vue"), component, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const widgetDef = nodes.find((n) => n.file.endsWith("/Component.vue") && n.name === "Widget");
    const runDef = nodes.find((n) => n.file.endsWith("/Component.vue") && n.name === "run");
    expect(widgetDef).toBeDefined();
    expect(runDef).toBeDefined();

    const instantiatesEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === widgetDef?.id && e.label === "instantiates");
    expect(instantiatesEdge).toBeDefined();
  });

  it("handles Svelte script blocks for calls edges", async () => {
    const root = await mkTmpDir("dg-svelte-se-");
    const component = `
<script>
export function helper() {}
export function run() {
  helper();
}
</script>
`;
    await fsp.writeFile(path.join(root, "Component.svelte"), component, "utf8");

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map((n) => ({
      ...n,
      file: normalizePath(n.file),
    }));

    const helperDef = nodes.find((n) => n.file.endsWith("/Component.svelte") && n.name === "helper");
    const runDef = nodes.find((n) => n.file.endsWith("/Component.svelte") && n.name === "run");
    expect(helperDef).toBeDefined();
    expect(runDef).toBeDefined();

    const callsEdge = sg.edges.find((e) => e.from === runDef?.id && e.to === helperDef?.id && e.label === "calls");
    expect(callsEdge).toBeDefined();
  });
});
