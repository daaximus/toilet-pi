// OMP's live Settings instance owns merging, persistence and advisor refresh.
// Never read/write settings files directly or expose arbitrary settings values.
export function createOmpRoleControls({ settings, getKnownRoleIds, getRoleInfo, resolveModelRoleValue,
  roleCandidatePool, modelRegistry, getStorage = () => settings.get("modelRoleStorage") }) {
  const methods = ["setModelRole", "setProjectModelRole", "clearProjectModelRole", "flush",
    "getModelRole", "getModelRoleSource", "getGlobalModelRole", "getProjectModelRole"];
  if (!settings || methods.some(method => typeof settings[method] !== "function") ||
      typeof getKnownRoleIds !== "function" || typeof getRoleInfo !== "function" ||
      typeof resolveModelRoleValue !== "function") return null;
  const candidates = new Map();
  // Resolve storage now: incompatible native APIs must fail during optional
  // capability loading, not later while sending a session hello.
  getStorage();
  getKnownRoleIds(settings);
  return {
    storage: () => getStorage() === "project" ? "project" : "global",
    models(sessionModels) {
      candidates.clear();
      const models = new Map(sessionModels.map(model => [`${model.provider}/${model.id}`, model]));
      for (const role of getKnownRoleIds(settings)) {
        const pool = roleCandidatePool ? roleCandidatePool(role, settings, modelRegistry) : sessionModels;
        for (const model of pool) {
          const key = `${model.provider}/${model.id}`;
          models.set(key, model);
          if (!candidates.has(key)) candidates.set(key, []);
          candidates.get(key).push(role);
        }
      }
      return [...models.values()];
    },
    allowedRoles: model => candidates.get(`${model.provider}/${model.id}`) || [],
    list(models) {
      return getKnownRoleIds(settings).map(id => {
        const value = settings.getModelRole(id);
        const resolved = value ? resolveModelRoleValue(value, models, { settings }) : {};
        return { id, name: getRoleInfo(id, settings).name, configured: !!value,
          provider: resolved.model?.provider || null, modelId: resolved.model?.id || null,
          thinkingLevel: resolved.thinkingLevel || null, source: settings.getModelRoleSource(id) };
      });
    },
    async set({ role, scope, clear, provider, modelId, thinkingLevel }) {
      const value = clear ? undefined : `${provider}/${modelId}${thinkingLevel === undefined ? "" : `:${thinkingLevel}`}`;
      if (scope === "project") {
        if (clear) settings.clearProjectModelRole(role);
        else settings.setProjectModelRole(role, value);
      } else settings.setModelRole(role, value);
      await settings.flush();
      // Verify the persisted layer, not the effective value: a project setting
      // can intentionally override an updated global fallback.
      const saved = scope === "project" ? settings.getProjectModelRole(role) : settings.getGlobalModelRole(role);
      return saved === value;
    },
  };
}
