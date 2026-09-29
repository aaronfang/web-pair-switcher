const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const optionsPath = path.join(__dirname, "..", "options.js");
const optionsSource = fs.readFileSync(optionsPath, "utf8");

function createOptionsContext() {
  const field = { addEventListener() {} };
  const context = vm.createContext({
    document: {
      addEventListener() {},
      querySelector() { return field; }
    },
    setTimeout() {}
  });
  vm.runInContext(optionsSource, context, { filename: optionsPath });
  return context;
}

test("option-page function keys match the native helper range", () => {
  const context = createOptionsContext();

  assert.equal(context.keyName({ code: "F1" }), "F1");
  assert.equal(context.keyName({ code: "F12" }), "F12");
  assert.equal(context.keyName({ code: "F13" }), null);
});

test("Backspace uses the native helper's Delete key name", () => {
  const context = createOptionsContext();

  assert.equal(context.keyName({ code: "Backspace" }), "Delete");
});
