// Runtime-independent model control. Native API access is injected so tests
// never start a real agent, read credentials, or make provider calls.
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

class ControlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function failure(code, message) {
  return new ControlError(code, message);
}

export function createModelController({ pi, getContext, loadThinkingLevels, loadRoleControls, hasPendingInput = () => false }) {
  let configuring = false;
  const runtimes = new WeakMap();
  function bindContext(ctx) {
    if (!ctx || runtimes.has(ctx)) return;
    const state = { controls: null, models: [], ready: null };
    // Called from a session event so OMP resolves session-scoped settings,
    // never another SDK session's process-global settings.
    state.ready = Promise.resolve().then(() => loadRoleControls?.(ctx))
      .then(controls => { state.controls = controls; }, () => {});
    runtimes.set(ctx, state);
  }

  function configuration() {
    const ctx = getContext();
    const level = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : ctx?.thinkingLevel;
    return {
      provider: ctx?.model?.provider || null,
      modelId: ctx?.model?.id || null,
      thinkingLevel: LEVELS.has(level) ? level : null,
      ...(runtimes.get(ctx)?.controls ? {
        roles: runtimes.get(ctx).controls.list(runtimes.get(ctx).models),
        roleStorage: runtimes.get(ctx).controls.storage(),
      } : {}),
    };
  }

  function checkContext(ctx, sessionGuid) {
    if (!ctx || getContext() !== ctx || ctx.sessionManager.getSessionId() !== sessionGuid) {
      throw failure("session_changed", "Session changed; inspect state before retrying");
    }
  }

  function checkIdle(ctx) {
    if (!ctx.isIdle() || ctx.hasPendingMessages() || hasPendingInput()) {
      throw failure("busy", "Session is busy or has queued input; wait or abort first");
    }
  }

  async function run(request) {
    const reply = { type: "session_response", requestId: request.requestId, sessionGuid: request.sessionGuid };
    let ownsLock = false;
    let mutationStarted = false;
    try {
      const ctx = getContext();
      checkContext(ctx, request.sessionGuid);
      if (configuring) throw failure("busy", "Session is being configured");
      bindContext(ctx);
      const runtime = runtimes.get(ctx);
      await runtime.ready;
      checkContext(ctx, request.sessionGuid);
      if (configuring) throw failure("busy", "Session is being configured");
      const isRole = request.role !== undefined;
      if (isRole && !runtime.controls) throw failure("unsupported", "This runtime does not expose OMP role settings");
      if (request.operation === "get_config") {
        if (runtime.controls && typeof ctx.modelRegistry?.getAvailable === "function") {
          runtime.models = runtime.controls.models(await ctx.modelRegistry.getAvailable());
          checkContext(ctx, request.sessionGuid);
        }
        return { ...reply, success: true, data: { configuration: configuration() } };
      }
      if (!["get_models", "configure"].includes(request.operation)) {
        throw failure("unsupported", "Unknown session operation");
      }
      if (request.operation === "configure") {
        checkIdle(ctx);
        configuring = ownsLock = true;
        if (!isRole && (typeof pi.setModel !== "function" || typeof pi.setThinkingLevel !== "function")) {
          throw failure("unsupported", "This runtime cannot configure model/thinking through the extension API");
        }
      }
      if (typeof ctx.modelRegistry?.getAvailable !== "function") {
        throw failure("unsupported", "This runtime cannot enumerate available models");
      }
      let levelsFor;
      try {
        levelsFor = await loadThinkingLevels();
      } catch {
        throw failure("unsupported", "Runtime thinking-level enumeration is unavailable; update the OMP/Pi runtime");
      }
      if (typeof levelsFor !== "function") throw failure("unsupported", "Runtime does not expose supported thinking levels");
      const sessionModels = await ctx.modelRegistry.getAvailable();
      const available = runtime.controls ? runtime.controls.models(sessionModels) : sessionModels;
      const sessionKeys = new Set(sessionModels.map(model => `${model.provider}/${model.id}`));
      checkContext(ctx, request.sessionGuid);
      runtime.models = available;
      const models = available.map(model => {
        const levels = levelsFor(model);
        if (!Array.isArray(levels) || !levels.length || !levels.every(level => LEVELS.has(level))) {
          throw failure("unsupported", "Runtime returned unsupported thinking-level metadata");
        }
        // Explicit projection: model objects can contain authentication headers.
        return { provider: model.provider, id: model.id, name: model.name || model.id, thinkingLevels: levels,
          ...(runtime.controls ? { roles: runtime.controls.allowedRoles(model), session: sessionKeys.has(`${model.provider}/${model.id}`) } : {}) };
      });
      if (request.operation === "get_models") {
        return { ...reply, success: true, data: { configuration: configuration(), models } };
      }
      checkIdle(ctx);
      if (isRole) {
        if (!runtime.controls.list(available).some(role => role.id === request.role)) {
          throw failure("unsupported_role", "Role is not supported by this runtime");
        }
        const scope = request.scope ?? runtime.controls.storage();
        if (!["global", "project"].includes(scope) || (request.clear !== undefined && request.clear !== true) ||
            (request.clear && (request.provider !== undefined || request.modelId !== undefined || request.thinkingLevel !== undefined))) {
          throw failure("invalid_selection", "Specify a role model or clear the role in global/project settings");
        }
        if (!request.clear) {
          const target = available.find(model => model.provider === request.provider && model.id === request.modelId);
          if (!target || !runtime.controls.allowedRoles(target).includes(request.role)) {
            throw failure("unavailable_model", "Model is not available for this role in this runtime");
          }
          if (request.thinkingLevel !== undefined && !["auto", "inherit"].includes(request.thinkingLevel) &&
              !levelsFor(target).includes(request.thinkingLevel)) {
            throw failure("unsupported_level", "Thinking level is not supported by the selected role model");
          }
        }
        mutationStarted = true;
        if (!await runtime.controls.set({ ...request, scope })) {
          throw failure("configuration_changed", "Runtime did not persist the requested role configuration");
        }
        checkContext(ctx, request.sessionGuid);
        return { ...reply, success: true, data: { configuration: configuration() } };
      }
      if (request.scope !== undefined || request.clear !== undefined) {
        throw failure("invalid_selection", "Scope and clear require a role");
      }
      const hasModel = request.provider !== undefined || request.modelId !== undefined;
      if ((!hasModel && request.thinkingLevel === undefined) ||
          (hasModel && (!request.provider || !request.modelId))) {
        throw failure("invalid_selection", "Specify provider/model together, a thinking level, or both");
      }
      const target = hasModel
        ? sessionModels.find(model => model.provider === request.provider && model.id === request.modelId)
        : ctx.model;
      if (!target) throw failure("unavailable_model", "Model is not available in this session's runtime");
      if (request.thinkingLevel !== undefined && !levelsFor(target).includes(request.thinkingLevel)) {
        throw failure("unsupported_level", `Thinking level ${request.thinkingLevel} is not supported by ${target.provider}/${target.id}`);
      }
      // Both selections are validated before the first mutation. This is a
      // serialized remote operation, NOT a transaction in the native Pi API.
      if (hasModel) {
        mutationStarted = true;
        if (await pi.setModel(target) === false) throw failure("unavailable_model", "Runtime refused the model (authentication may be unavailable)");
        checkContext(ctx, request.sessionGuid);
        checkIdle(ctx);
      }
      if (request.thinkingLevel !== undefined) {
        mutationStarted = true;
        pi.setThinkingLevel(request.thinkingLevel);
      }
      const effective = configuration();
      if (effective.provider !== target.provider || effective.modelId !== target.id ||
          (request.thinkingLevel !== undefined && effective.thinkingLevel !== request.thinkingLevel)) {
        throw failure("configuration_changed", "Runtime did not retain the requested configuration");
      }
      return { ...reply, success: true, data: { configuration: effective } };
    } catch (error) {
      const known = error instanceof ControlError;
      const message = known ? error.message : "Runtime model operation failed";
      return { ...reply, success: false, error: {
        code: known ? error.code : "runtime_error",
        message: mutationStarted ? `${message}; configuration may have changed. Inspect state before retrying.` : message,
      } };
    } finally {
      if (ownsLock) configuring = false;
    }
  }

  return { run, configuration, bindContext, isConfiguring: () => configuring };
}
