export type AngularJsRegistrationKind =
  | "component"
  | "constant"
  | "controller"
  | "directive"
  | "factory"
  | "filter"
  | "provider"
  | "service"
  | "value";

export type AngularJsRegistration = {
  kind: AngularJsRegistrationKind;
  name: string;
};

export type AngularJsReference =
  | { kind: "templateUrl"; value: string }
  | { kind: "controller"; value: string }
  | { kind: "inject"; value: string };

const ANGULAR_JS_REGISTRATION_PATTERN =
  /\.\s*(controller|service|factory|directive|component|provider|filter|value|constant)\s*\(\s*(['"])([^'"`]+)\2/gs;

const ANGULAR_JS_ARRAY_INJECTION_PATTERN =
  /\.\s*(controller|service|factory|directive|component|provider|filter)\s*\(\s*(['"])([^'"`]+)\2\s*,\s*\[([\s\S]*?)function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/gs;

const ANGULAR_JS_FUNCTION_INJECTION_PATTERN =
  /\.\s*(controller|service|factory|directive|component|provider|filter)\s*\(\s*(['"])([^'"`]+)\2\s*,\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/gs;

const ANGULAR_JS_COMPONENT_CONTROLLER_PATTERN =
  /\.\s*component\s*\(\s*(['"])([^'"`]+)\1\s*,\s*\{[\s\S]*?controller\s*:\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/gs;

const ANGULAR_JS_INJECT_ASSIGNMENT_PATTERN =
  /([A-Za-z_$][\w$]*)\s*\.\s*\$inject\s*=\s*\[([\s\S]*?)\]/gs;

const ANGULAR_JS_TEMPLATE_URL_PATTERN =
  /templateUrl\s*:\s*(['"`])([^'"`]+)\1/gs;

const ANGULAR_JS_CONTROLLER_REF_PATTERN =
  /controller\s*:\s*(['"])([^'"`]+)\1/gs;

function looksLikeAngularJsSource(source: string): boolean {
  return /angular\s*\.\s*module\s*\(/.test(source);
}

function parseRegistrationKind(
  value: string,
): AngularJsRegistrationKind | undefined {
  if (value === "component") return "component";
  if (value === "constant") return "constant";
  if (value === "controller") return "controller";
  if (value === "directive") return "directive";
  if (value === "factory") return "factory";
  if (value === "filter") return "filter";
  if (value === "provider") return "provider";
  if (value === "service") return "service";
  if (value === "value") return "value";
  return undefined;
}

function parseQuotedValues(value: string): string[] {
  const out: string[] = [];
  const quotedValuePattern = /(['"])([^'"`]+)\1/g;
  for (const match of value.matchAll(quotedValuePattern)) {
    const token = match[2]?.trim();
    if (token) out.push(token);
  }
  return out;
}

function parseParameterNames(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.{3}/, ""))
    .map((entry) => entry.replace(/\s*=.*$/, ""))
    .map((entry) => entry.replace(/[\{\}\[\]]/g, "").trim())
    .filter(Boolean);
}

function pushUnique(target: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

export function extractAngularJsRegistrations(
  source: string,
): AngularJsRegistration[] {
  if (!looksLikeAngularJsSource(source)) return [];

  const out: AngularJsRegistration[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(ANGULAR_JS_REGISTRATION_PATTERN)) {
    const kind = parseRegistrationKind(match[1]?.trim() ?? "");
    const name = match[3]?.trim();
    if (!kind || !name) continue;
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name });
  }
  return out;
}

export function extractAngularJsReferences(source: string): AngularJsReference[] {
  if (!looksLikeAngularJsSource(source)) return [];

  const out: AngularJsReference[] = [];
  const seen = new Set<string>();

  for (const match of source.matchAll(ANGULAR_JS_TEMPLATE_URL_PATTERN)) {
    const value = match[2]?.trim();
    if (!value) continue;
    const key = `templateUrl:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "templateUrl", value });
  }

  for (const match of source.matchAll(ANGULAR_JS_CONTROLLER_REF_PATTERN)) {
    const value = match[2]?.trim();
    if (!value) continue;
    const key = `controller:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "controller", value });
  }

  const injectionTokens: string[] = [];
  const injectionSeen = new Set<string>();
  for (const match of source.matchAll(ANGULAR_JS_ARRAY_INJECTION_PATTERN)) {
    for (const value of parseQuotedValues(match[4] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }
  for (const match of source.matchAll(ANGULAR_JS_FUNCTION_INJECTION_PATTERN)) {
    for (const value of parseParameterNames(match[4] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }
  for (const match of source.matchAll(ANGULAR_JS_COMPONENT_CONTROLLER_PATTERN)) {
    for (const value of parseParameterNames(match[3] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }
  for (const match of source.matchAll(ANGULAR_JS_INJECT_ASSIGNMENT_PATTERN)) {
    for (const value of parseQuotedValues(match[2] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }

  for (const value of injectionTokens) {
    const key = `inject:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "inject", value });
  }

  return out;
}
