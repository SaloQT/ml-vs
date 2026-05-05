// Static reference check: parse every src/*.js and assert that every
// identifier referenced in code is either declared in that module, imported,
// a known JS / browser / Node global, or attached as a property access. Catches
// "startRun.click()" / typo-class bugs that the runtime smoke test would only
// hit if it could actually load and click through main.js (which it cannot,
// because main.js boots the whole app at module load).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "acorn";
import * as walk from "acorn-walk";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Identifiers always-available at runtime that don't need to be declared.
// Conservative: prefer letting genuine undefined-refs be flagged over silencing
// false positives. Add new entries when (and only when) they trip a real file.
const KNOWN_GLOBALS = new Set([
  // ECMAScript core
  "globalThis", "undefined", "Infinity", "NaN", "console",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Function", "RegExp", "Date", "Math", "JSON", "Error", "TypeError", "RangeError",
  "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "Promise", "Proxy", "Reflect",
  "Map", "Set", "WeakMap", "WeakSet",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array",
  "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "structuredClone", "queueMicrotask",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate", "clearImmediate",
  // Browser/DOM (renderer + main)
  "window", "document", "self", "navigator", "location", "history", "screen",
  "Image", "HTMLCanvasElement", "HTMLImageElement", "OffscreenCanvas", "HTMLElement",
  "Path2D", "ImageData", "CanvasGradient", "CanvasPattern",
  "requestAnimationFrame", "cancelAnimationFrame",
  "fetch", "Headers", "Request", "Response", "URL", "URLSearchParams",
  "FormData", "FileReader", "Blob", "File",
  "localStorage", "sessionStorage",
  "performance", "alert", "confirm", "prompt",
  "addEventListener", "removeEventListener",
  "Worker", "MessageChannel", "MessagePort", "BroadcastChannel",
  "AudioContext", "webkitAudioContext",
  "CustomEvent", "Event", "EventTarget",
  "DOMException",
  // Node-ish (worker pools / trainers may run under either runtime)
  "process", "Buffer", "__dirname", "__filename",
  // Common browser-shimmed names sometimes referenced as globals
  "WebAssembly",
]);

// Acorn `Identifier` visitor produces every Identifier node, including
// declaration names (good — those become declared bindings) and references
// (which is what we want to validate). Property keys in `obj.foo` are NOT
// emitted as Identifier references (acorn marks them computed=false), so
// `foo` in `obj.foo` is silently ignored, which is what we want.

function declaredBindings(ast) {
  const declared = new Set();
  const add = (n) => { if (n && n.name) declared.add(n.name); };
  walk.simple(ast, {
    VariableDeclarator(node) {
      collectPattern(node.id, declared);
    },
    FunctionDeclaration(node) { add(node.id); collectParams(node.params, declared); },
    FunctionExpression(node) { add(node.id); collectParams(node.params, declared); },
    ArrowFunctionExpression(node) { collectParams(node.params, declared); },
    ClassDeclaration(node) { add(node.id); },
    ClassExpression(node) { add(node.id); },
    ImportDeclaration(node) {
      for (const spec of node.specifiers) add(spec.local);
    },
    ExportNamedDeclaration(node) {
      // `export {x}` doesn't introduce a binding; the binding came from elsewhere.
    },
    CatchClause(node) { if (node.param) collectPattern(node.param, declared); },
    // `for (const x of y)` etc. are covered by VariableDeclarator above.
  });
  return declared;
}

function collectPattern(pat, out) {
  if (!pat) return;
  switch (pat.type) {
    case "Identifier": out.add(pat.name); break;
    case "ObjectPattern":
      for (const prop of pat.properties) {
        if (prop.type === "RestElement") collectPattern(prop.argument, out);
        else collectPattern(prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const el of pat.elements) if (el) collectPattern(el, out);
      break;
    case "RestElement": collectPattern(pat.argument, out); break;
    case "AssignmentPattern": collectPattern(pat.left, out); break;
  }
}

function collectParams(params, out) {
  for (const p of params) collectPattern(p, out);
}

function findFreeReferences(ast, declared) {
  const undef = [];
  // Skip Identifier nodes that are: property names, labels, or declaration ids.
  // We use `walk.ancestor` so we can detect property-key context.
  walk.ancestor(ast, {
    Identifier(node, ancestors) {
      const name = node.name;
      if (declared.has(name) || KNOWN_GLOBALS.has(name)) return;
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      // obj.foo : skip `foo`
      if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      // {foo: ...} or {foo} shorthand value vs key — skip key-only
      if (parent.type === "Property" && parent.key === node && !parent.computed && parent.shorthand === false) return;
      // method shorthand: { foo() {} } — `foo` is the key
      if (parent.type === "Property" && parent.key === node && !parent.computed) return;
      if (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) return;
      if (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed) return;
      // labels
      if (parent.type === "LabeledStatement" && parent.label === node) return;
      if (parent.type === "BreakStatement" && parent.label === node) return;
      if (parent.type === "ContinueStatement" && parent.label === node) return;
      // export specifier local/exported names
      if (parent.type === "ExportSpecifier") {
        if (parent.exported === node) return;
        // local refs in export {x as y} — fall through and validate `x`
      }
      if (parent.type === "ImportSpecifier" && parent.imported === node) return;
      // shorthand object property { foo } where foo IS a value reference — fall through
      undef.push({ name, line: node.loc.start.line, column: node.loc.start.column });
    },
  });
  return undef;
}

const files = readdirSync(srcDir)
  .filter((f) => f.endsWith(".js"))
  // ppoNodeRolloutWorker imports worker_threads — fine to parse, but it has
  // module-level guard logic. We still parse it for undef refs.
  ;

for (const file of files) {
  test(`no undefined references: src/${file}`, () => {
    const src = readFileSync(join(srcDir, file), "utf8");
    const ast = parse(src, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
    const declared = declaredBindings(ast);
    const undef = findFreeReferences(ast, declared);
    if (undef.length) {
      const summary = undef
        .map((u) => `  src/${file}:${u.line}:${u.column}  ${u.name}`)
        .slice(0, 20)
        .join("\n");
      assert.fail(`Undeclared identifiers in src/${file}:\n${summary}${undef.length > 20 ? `\n  ... and ${undef.length - 20} more` : ""}`);
    }
  });
}
