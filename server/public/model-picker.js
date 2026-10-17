// Same correlated model-control API as the CLI. No implicit resume or retry.
export function createModelPicker({ root, send, getSession, notify, label = null, document = root.ownerDocument }) {
  let sessionId = null;
  let models = [];
  let configuration = null;
  let pending = null;
  let connected = false;
  let scopeInitialized = false;
  let loaded = false;
  const load = document.createElement("button");
  load.textContent = "Load models";
  load.type = "button";
  const model = document.createElement("select");
  model.setAttribute("aria-label", "Session model");
  const thinking = document.createElement("select");
  thinking.setAttribute("aria-label", "Session thinking level");
  const role = document.createElement("select");
  role.setAttribute("aria-label", "Model target");
  const scope = document.createElement("select");
  scope.setAttribute("aria-label", "Role settings scope");
  for (const value of ["global", "project"]) {
    const option = document.createElement("option");
    option.value = value; option.textContent = value === "global" ? "Global settings" : "Project settings";
    scope.append(option);
  }
  const clear = document.createElement("button");
  clear.type = "button"; clear.textContent = "Reset role";
  const apply = document.createElement("button");
  apply.textContent = "Apply to session";
  apply.type = "button";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  root.append(load, role, model, thinking, scope, apply, clear, status);
  function cancel() { if (pending) clearTimeout(pending.timer); pending = null; }
  function selectedConfiguration() {
    return role.value ? configuration?.roles?.find(item => item.id === role.value) : configuration;
  }
  function describe() {
    const current = selectedConfiguration();
    if (!role.value) return `Session: ${configuration?.provider || "—"}/${configuration?.modelId || "—"} (${configuration?.thinkingLevel || "default"})${configuration?.roles ? "" : " · Role settings unavailable; update/reload the OMP runtime and extension."}`;
    const selection = current?.configured
      ? `${current.provider || "unavailable"}/${current.modelId || "unresolved"} (${current.thinkingLevel || "default"})`
      : "Automatic (not assigned)";
    return `${current?.name || role.value}: ${selection} · ${current?.source || "default"} · Saves affect future role uses; project overrides global.`;
  }
  function levels() {
    thinking.replaceChildren();
    const selected = model.value === "" ? undefined : models[Number(model.value)];
    const current = selectedConfiguration();
    if (role.value) {
      const option = document.createElement("option");
      option.value = ""; option.textContent = "Runtime default thinking";
      thinking.append(option);
      for (const level of ["auto", "inherit"]) {
        const option = document.createElement("option");
        option.value = level; option.textContent = level;
        thinking.append(option);
      }
    }
    for (const level of selected?.thinkingLevels || []) {
      const option = document.createElement("option");
      option.value = level; option.textContent = level;
      thinking.append(option);
    }
    if ([...thinking.options].some(option => option.value === current?.thinkingLevel)) thinking.value = current.thinkingLevel;
  }
  function renderModels() {
    const previousRole = role.value;
    role.replaceChildren();
    const sessionOption = document.createElement("option");
    sessionOption.value = ""; sessionOption.textContent = "Current session";
    role.append(sessionOption);
    for (const item of configuration?.roles || []) {
      const option = document.createElement("option");
      option.value = item.id; option.textContent = `${item.name} (${item.id})`;
      role.append(option);
    }
    if (configuration?.roles?.some(item => item.id === previousRole)) role.value = previousRole;
    const current = selectedConfiguration();
    model.replaceChildren();
    models.forEach((m, i) => {
      if (role.value ? m.roles && !m.roles.includes(role.value) : m.session === false) return;
      const option = document.createElement("option");
      option.value = String(i); option.textContent = `${m.provider}/${m.id}`;
      model.append(option);
    });
    const selected = models.findIndex(m => m.provider === current?.provider && m.id === current?.modelId);
    if (selected >= 0 && [...model.options].some(option => option.value === String(selected))) model.value = String(selected);
    levels();
    scope.hidden = clear.hidden = !role.value;
    apply.textContent = role.value ? `Save ${scope.value} role` : "Apply to session";
    clear.textContent = `Reset ${scope.value} role`;
  }
  function sync(isConnected) {
    connected = isConnected;
    const session = getSession();
    if (session.sessionGuid !== sessionId) {
      cancel(); sessionId = session.sessionGuid; models = []; configuration = session.configuration; role.value = "";
      scopeInitialized = false; loaded = false;
      renderModels(); status.textContent = "";
    }
    if (!connected && pending) { cancel(); loaded = false; status.textContent = "Disconnected; outcome unknown. Reload models before retrying."; models = []; renderModels(); }
    if (session.configuration && JSON.stringify(configuration) !== JSON.stringify(session.configuration)) {
      configuration = session.configuration; renderModels();
      if (!pending) status.textContent = describe();
    }
    const unavailable = !connected || !sessionId || !session.owner || !!pending;
    load.disabled = unavailable;
    const mutationUnavailable = unavailable || session.busy || !!session.queuedInputs?.length || !!session.pendingInputs?.length;
    role.disabled = unavailable || !loaded;
    model.disabled = mutationUnavailable || !model.options.length;
    thinking.disabled = model.disabled;
    apply.disabled = model.disabled;
    scope.disabled = clear.disabled = mutationUnavailable || !loaded;
    if (label) {
      const current = configuration || session.configuration;
      label.textContent = current ? `${current.modelId} · ${current.thinkingLevel}` : (session.model || "");
    }
  }
  function request(operation, selection = {}) {
    if (pending || !sessionId || !connected) return;
    // crypto.randomUUID is undefined outside secure contexts (plain http on a LAN IP).
    const requestId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pending = { requestId, sessionGuid: sessionId, timer: setTimeout(() => {
      pending = null; loaded = false; models = []; renderModels(); status.textContent = "Timed out; outcome unknown. Reload models before retrying."; sync(connected);
    }, 20000) };
    status.textContent = operation === "configure" ? "Applying…" : "Loading…";
    if (!send({ type: "session_request", requestId, sessionGuid: sessionId, operation, ...selection })) {
      cancel(); status.textContent = "Not connected";
    }
    sync(connected);
  }
  load.addEventListener("click", () => request("get_models"));
  model.addEventListener("change", levels);
  role.addEventListener("change", () => {
    renderModels(); status.textContent = describe(); sync(connected);
  });
  scope.addEventListener("change", () => {
    scopeInitialized = true;
    apply.textContent = `Save ${scope.value} role`;
    clear.textContent = `Reset ${scope.value} role`;
  });
  clear.addEventListener("click", () => {
    if (!clear.disabled && role.value) request("configure", { role: role.value, scope: scope.value, clear: true });
  });
  apply.addEventListener("click", () => {
    const selected = model.value === "" ? undefined : models[Number(model.value)];
    if (!selected || apply.disabled) return;
    request("configure", { provider: selected.provider, modelId: selected.id,
      ...(thinking.value ? { thinkingLevel: thinking.value } : {}),
      ...(role.value ? { role: role.value, scope: scope.value } : {}) });
  });
  function receive(message) {
    if (message.type !== "session_response" || !pending || message.requestId !== pending.requestId || message.sessionGuid !== pending.sessionGuid) return;
    cancel();
    if (message.sessionGuid !== getSession().sessionGuid) return;
    if (message.success) {
      configuration = message.data.configuration;
      getSession().configuration = configuration;
      getSession().model = configuration.modelId;
      if (message.data.models) {
        models = message.data.models; loaded = true;
        if (!scopeInitialized) {
          scope.value = configuration?.roleStorage || "global";
          scopeInitialized = true;
        }
      }
      renderModels(); status.textContent = describe();
    } else {
      status.textContent = message.error?.message || "Model request failed";
      notify(status.textContent, "error");
      loaded = false; models = []; renderModels();
    }
    sync(connected);
  }
  return { sync, receive, dispose: cancel };
}
