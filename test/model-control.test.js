import assert from "node:assert/strict";
import test from "node:test";
import { createModelController } from "../model-control.js";
import { createOmpRoleControls } from "../omp-model-controls.js";

function fixture() {
  const models = [
    { provider: "test", id: "small", name: "Small", levels: ["off"], headers: { Authorization: "secret" } },
    { provider: "test", id: "large", name: "Large", levels: ["off", "high", "max"], baseUrl: "secret-url" },
  ];
  let level = "off";
  const calls = [];
  const ctx = {
    model: models[0], isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { getAvailable: () => models },
    sessionManager: { getSessionId: () => "session" },
  };
  let currentContext = ctx;
  const pi = {
    getThinkingLevel: () => level,
    async setModel(model) { calls.push(["model", model.id]); ctx.model = model; return true; },
    setThinkingLevel(value) { calls.push(["thinking", value]); level = value; },
  };
  const options = { pi, getContext: () => currentContext, loadThinkingLevels: async () => model => model.levels };
  const controller = createModelController(options);
  const request = (operation, fields = {}) => controller.run({ requestId: "request", sessionGuid: "session", operation, ...fields });
  return { models, pi, ctx, options, calls, controller, request, replaceContext: () => { currentContext = { ...ctx }; } };
}

test("enumerates models and their exact levels together without exposing private metadata", async () => {
  const f = fixture();
  const response = await f.request("get_models");
  assert.equal(response.success, true);
  assert.deepEqual(response.data.models, [
    { provider: "test", id: "small", name: "Small", thinkingLevels: ["off"] },
    { provider: "test", id: "large", name: "Large", thinkingLevels: ["off", "high", "max"] },
  ]);
  assert.deepEqual(response.data.configuration, { provider: "test", modelId: "small", thinkingLevel: "off" });
  assert.deepEqual(f.calls, []);
});

test("validates model and thinking together before either mutation", async () => {
  const f = fixture();
  const response = await f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "low" });
  assert.equal(response.error.code, "unsupported_level");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request("configure", { provider: "test", modelId: "missing" })).error.code, "unavailable_model");
  assert.deepEqual(f.calls, []);
});

test("sets a validated model/thinking pair and reports effective configuration", async () => {
  const f = fixture();
  const response = await f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "max" });
  assert.equal(response.success, true);
  assert.deepEqual(f.calls, [["model", "large"], ["thinking", "max"]]);
  assert.deepEqual(response.data.configuration, { provider: "test", modelId: "large", thinkingLevel: "max" });
});

test("busy and queued sessions reject mutations but allow enumeration", async () => {
  const f = fixture();
  f.ctx.isIdle = () => false;
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "busy");
  assert.equal((await f.request("get_models")).success, true);
  f.ctx.isIdle = () => true;
  f.ctx.hasPendingMessages = () => true;
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "busy");
  assert.deepEqual(f.calls, []);
});

test("input accepted by the extension but not yet in Pi's queue blocks configuration", async () => {
  const f = fixture();
  const controller = createModelController({ ...f.options, hasPendingInput: () => true });
  const response = await controller.run({ requestId: "r", sessionGuid: "session", operation: "configure", thinkingLevel: "off" });
  assert.equal(response.error.code, "busy");
  assert.deepEqual(f.calls, []);
});

test("holds configuration lock through async model changes and rejects concurrent requests", async () => {
  const f = fixture();
  let release;
  const original = f.pi.setModel;
  f.pi.setModel = async model => { await new Promise(resolve => { release = resolve; }); return original(model); };
  const first = f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "high" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.isConfiguring(), true);
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "busy");
  release();
  assert.equal((await first).success, true);
  assert.equal(f.controller.isConfiguring(), false);
});

test("a session switch during enumeration prevents configuration", async () => {
  const f = fixture();
  f.ctx.modelRegistry.getAvailable = async () => { f.replaceContext(); return f.models; };
  assert.equal((await f.request("configure", { thinkingLevel: "off" })).error.code, "session_changed");
  assert.deepEqual(f.calls, []);
});

test("missing capability helper is an explicit unsupported error without mutations", async () => {
  const f = fixture();
  const controller = createModelController({ ...f.options, loadThinkingLevels: async () => { throw new Error("not installed"); } });
  const response = await controller.run({ requestId: "x", sessionGuid: "session", operation: "get_models" });
  assert.equal(response.error.code, "unsupported");
  assert.deepEqual(f.calls, []);
});

test("errors do not leak provider credentials and partial changes are reported honestly", async () => {
  const f = fixture();
  f.pi.setThinkingLevel = () => { throw Object.assign(new Error("Authorization: secret"), { code: "HTTP_ERROR" }); };
  const response = await f.request("configure", { provider: "test", modelId: "large", thinkingLevel: "high" });
  assert.equal(response.success, false);
  assert.match(response.error.message, /configuration may have changed/);
  assert.doesNotMatch(response.error.message, /secret/);
  assert.equal(f.controller.configuration().modelId, "large");
  assert.equal(f.controller.isConfiguring(), false);
});

test("runtime refusal or clamping never reports successful requested configuration", async () => {
  const f = fixture();
  f.pi.setModel = async () => false;
  assert.equal((await f.request("configure", { provider: "test", modelId: "large" })).error.code, "unavailable_model");
  f.ctx.model = f.models[1];
  f.pi.setThinkingLevel = () => {};
  assert.equal((await f.request("configure", { thinkingLevel: "high" })).error.code, "configuration_changed");
});

function roleFixture(overrides = {}) {
  const f = fixture();
  const global = { advisor: "test/large:high" };
  const project = {};
  const saves = [];
  const settings = {
    get: key => key === "modelRoleStorage" ? "project" : undefined,
    getModelRole: role => project[role] || global[role],
    getModelRoleSource: role => project[role] ? "project" : global[role] ? "global" : "default",
    getGlobalModelRole: role => global[role],
    getProjectModelRole: role => project[role],
    setModelRole(role, value) { if (value === undefined) delete global[role]; else global[role] = value; },
    setProjectModelRole(role, value) { project[role] = value; },
    clearProjectModelRole(role) { delete project[role]; },
    async flush() { saves.push("flush"); },
  };
  const controls = createOmpRoleControls({
    settings, getKnownRoleIds: () => ["default", "advisor", "custom"],
    getRoleInfo: id => ({ name: id }),
    resolveModelRoleValue(value, models) {
      const [key, thinkingLevel] = value.split(":");
      return { model: models.find(model => `${model.provider}/${model.id}` === key), thinkingLevel };
    },
    ...overrides,
  });
  const controller = createModelController({ ...f.options, loadRoleControls: async () => controls });
  const request = (operation, fields = {}) => controller.run({ requestId: "r", sessionGuid: "session", operation, ...fields });
  return { ...f, controller, request, settings, global, project, saves, controls };
}

test("OMP enumerates actual roles and projects only model identities and settings metadata", async () => {
  const f = roleFixture();
  const response = await f.request("get_models");
  assert.equal(response.success, true);
  assert.equal(response.data.configuration.roleStorage, "project");
  assert.deepEqual(response.data.configuration.roles.map(role => role.id), ["default", "advisor", "custom"]);
  assert.deepEqual(response.data.configuration.roles[1], {
    id: "advisor", name: "advisor", configured: true, provider: "test", modelId: "large", thinkingLevel: "high", source: "global",
  });
  assert.doesNotMatch(JSON.stringify(response), /secret|headers|baseUrl/);
  assert.deepEqual((await f.request("get_config")).data.configuration.roles, response.data.configuration.roles);
});

test("OMP role assignments persist to the selected layer without changing the session", async () => {
  const f = roleFixture();
  const response = await f.request("configure", { role: "advisor", provider: "test", modelId: "small", thinkingLevel: "off" });
  assert.equal(response.success, true);
  assert.equal(f.project.advisor, "test/small:off");
  assert.equal(f.global.advisor, "test/large:high");
  assert.deepEqual(f.saves, ["flush"]);
  assert.deepEqual(f.calls, []);
  assert.equal(response.data.configuration.modelId, "small");
  assert.equal(response.data.configuration.roles[1].source, "project");
  assert.equal((await f.request("configure", { role: "advisor", scope: "global", provider: "test", modelId: "large", thinkingLevel: "max" })).success, true);
  assert.equal(f.global.advisor, "test/large:max");
  assert.equal(f.project.advisor, "test/small:off");
  assert.equal((await f.request("configure", { role: "advisor", scope: "project", clear: true })).success, true);
  assert.equal(f.project.advisor, undefined);
  assert.equal(f.controller.configuration().roles[1].thinkingLevel, "max");
});

test("OMP validates native role names, models, levels, scope and busy state before any persistence", async () => {
  const f = roleFixture();
  const selection = { role: "advisor", provider: "test", modelId: "large" };
  assert.equal((await f.request("configure", { ...selection, role: "guessed" })).error.code, "unsupported_role");
  assert.equal((await f.request("configure", { ...selection, modelId: "missing" })).error.code, "unavailable_model");
  assert.equal((await f.request("configure", { ...selection, thinkingLevel: "low" })).error.code, "unsupported_level");
  assert.equal((await f.request("configure", { ...selection, scope: "other" })).error.code, "invalid_selection");
  assert.equal((await f.request("configure", { ...selection, clear: true })).error.code, "invalid_selection");
  f.ctx.isIdle = () => false;
  assert.equal((await f.request("configure", selection)).error.code, "busy");
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.calls, []);
});

test("Pi explicitly rejects role changes instead of mutating the session", async () => {
  const f = fixture();
  assert.equal((await f.request("configure", { role: "advisor", provider: "test", modelId: "large" })).error.code, "unsupported");
  assert.deepEqual(f.calls, []);
});

test("OMP reports persistence failures without leaking settings or claiming success", async () => {
  const f = roleFixture();
  f.settings.flush = async () => { throw new Error("secret settings path"); };
  const result = await f.request("configure", { role: "advisor", scope: "global", provider: "test", modelId: "small" });
  assert.equal(result.success, false);
  assert.match(result.error.message, /configuration may have changed/);
  assert.doesNotMatch(result.error.message, /secret/);
  assert.equal(f.controller.isConfiguring(), false);
});

test("native role pools enumerate non-chat models but reject cross-kind and session assignment", async () => {
  const image = { provider: "test", id: "image", name: "Image", levels: ["off"] };
  const f = roleFixture({
    getKnownRoleIds: () => ["advisor", "image"],
    roleCandidatePool: role => role === "image" ? [image] : [{ provider: "test", id: "large", levels: ["off", "high", "max"] }],
    getStorage: () => "global",
  });
  delete f.settings.get;
  const response = await f.request("get_models");
  assert.equal(response.success, true);
  assert.equal(response.data.configuration.roleStorage, "global");
  assert.deepEqual(response.data.models.find(model => model.id === "image").roles, ["image"]);
  assert.equal(response.data.models.find(model => model.id === "image").session, false);
  assert.equal((await f.request("configure", { role: "advisor", provider: "test", modelId: "image" })).error.code, "unavailable_model");
  assert.equal((await f.request("configure", { provider: "test", modelId: "image" })).error.code, "unavailable_model");
  assert.equal((await f.request("configure", { role: "image", provider: "test", modelId: "image" })).success, true);
  assert.equal(f.global.image, "test/image");
});

test("incompatible optional role APIs never break hello or session model control", async () => {
  const f = fixture();
  const controller = createModelController({ ...f.options, loadRoleControls: async () => { throw new TypeError("missing native API"); } });
  controller.bindContext(f.ctx);
  assert.equal(controller.configuration().modelId, "small");
  const response = await controller.run({ requestId: "r", sessionGuid: "session", operation: "get_models" });
  assert.equal(response.success, true);
  assert.equal(response.data.configuration.roles, undefined);
});

test("native role auto and inherit selectors persist without becoming session selectors", async () => {
  const f = roleFixture();
  for (const thinkingLevel of ["auto", "inherit"]) {
    f.global.advisor = `test/large:${thinkingLevel}`;
    assert.equal((await f.request("get_models")).data.configuration.roles[1].thinkingLevel, thinkingLevel);
    const result = await f.request("configure", { role: "advisor", scope: "global", provider: "test", modelId: "large", thinkingLevel });
    assert.equal(result.success, true);
    assert.equal(f.global.advisor, `test/large:${thinkingLevel}`);
    assert.equal((await f.request("configure", { thinkingLevel })).error.code, "unsupported_level");
  }
});

test("clearing a configured role needs no available candidate model", async () => {
  const f = roleFixture();
  f.ctx.modelRegistry.getAvailable = () => [];
  const result = await f.request("configure", { role: "advisor", scope: "global", clear: true });
  assert.equal(result.success, true);
  assert.equal(f.global.advisor, undefined);
  assert.deepEqual(f.saves, ["flush"]);
});
