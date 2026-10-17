// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createModelPicker } from '../../public/model-picker.js';

function fixture() {
  const root = document.createElement('div');
  let session = { sessionGuid: 'session', owner: 'interactive', busy: false, queuedInputs: [] };
  const sent = [];
  const picker = createModelPicker({ root, send: message => { sent.push(message); return true; }, getSession: () => session, notify: vi.fn() });
  picker.sync(true);
  const [load, role, model, thinking, scope, apply, clear, status] = root.children;
  const respond = (fields = {}) => picker.receive({ type: 'session_response', requestId: sent.at(-1).requestId, sessionGuid: 'session', success: true,
    data: { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off' }, models: [
      { provider: 'fake', id: 'small', thinkingLevels: ['off'] }, { provider: 'fake', id: '<script>large</script>', thinkingLevels: ['off', 'high'] },
    ] }, ...fields });
  return { root, picker, load, role, model, thinking, scope, apply, clear, status, sent, respond, session, switchSession: () => { session = { ...session, sessionGuid: 'other', configuration: null }; picker.sync(true); } };
}

describe('browser model picker', () => {
  it('enumerates models and levels together, renders literal labels and validates the selected pair', () => {
    const f = fixture();
    try {
      expect(f.model.disabled).toBe(true);
      f.load.click(); expect(f.sent[0].operation).toBe('get_models'); expect(f.load.disabled).toBe(true);
      f.respond();
      expect(f.root.querySelector('script')).toBeNull();
      expect(f.model.options[1].textContent).toBe('fake/<script>large</script>');
      f.model.value = '1'; f.model.dispatchEvent(new Event('change'));
      expect([...f.thinking.options].map(o => o.value)).toEqual(['off', 'high']);
      f.thinking.value = 'high'; f.apply.click();
      expect(f.sent[1]).toMatchObject({ operation: 'configure', provider: 'fake', modelId: '<script>large</script>', thinkingLevel: 'high' });
    } finally { f.picker.dispose(); }
  });
  it('disables mutations while busy/queued and discards stale responses after selection changes', () => {
    const f = fixture();
    try {
      f.load.click(); f.respond();
      f.session.busy = true; f.picker.sync(true); expect(f.apply.disabled).toBe(true);
      f.session.busy = false; f.session.queuedInputs = [{}]; f.picker.sync(true); expect(f.apply.disabled).toBe(true);
      f.session.queuedInputs = []; f.picker.sync(true);
      f.load.click(); const old = { ...f.sent.at(-1) }; f.switchSession();
      f.picker.receive({ ...old, type: 'session_response', success: true, data: {} });
      expect(f.model.options.length).toBe(0);
    } finally { f.picker.dispose(); }
  });
  it('clears selections on disconnect/timeout instead of replaying configuration', () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.load.click(); vi.advanceTimersByTime(20000);
      expect(f.status.textContent).toContain('unknown'); expect(f.sent).toHaveLength(1);
      f.load.click(); f.picker.sync(false);
      expect(f.status.textContent).toContain('Disconnected'); expect(f.apply.disabled).toBe(true);
      f.picker.sync(true); expect(f.sent).toHaveLength(2);
    } finally { f.picker.dispose(); vi.useRealTimers(); }
  });
  it('loads models from an insecure context where crypto.randomUUID is unavailable', () => {
    // Plain http on a LAN IP (phone usage) is not a secure context: randomUUID is undefined.
    const randomUUID = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    const f = fixture();
    try {
      f.load.click();
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0].requestId).toEqual(expect.any(String));
      f.respond();
      expect(f.model.options.length).toBe(2);
    } finally {
      f.picker.dispose();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID, configurable: true });
    }
  });
  it('loads native roles, saves scoped assignments and resets without altering the session model', () => {
    const f = fixture();
    try {
      f.load.click();
      f.respond({ data: { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off', roleStorage: 'project', roles: [
        { id: 'advisor', name: 'Advisor', configured: true, provider: 'fake', modelId: 'large', thinkingLevel: 'high', source: 'global' },
        { id: 'custom', name: '<b>Custom</b>', configured: false, provider: null, modelId: null, thinkingLevel: null, source: 'default' },
      ] }, models: [
        { provider: 'fake', id: 'small', thinkingLevels: ['off'] },
        { provider: 'fake', id: 'large', thinkingLevels: ['off', 'high'] },
      ] } });
      expect([...f.role.options].map(option => option.value)).toEqual(['', 'advisor', 'custom']);
      expect(f.root.querySelector('b')).toBeNull();
      f.role.value = 'advisor'; f.role.dispatchEvent(new Event('change'));
      expect(f.model.value).toBe('1');
      expect(f.thinking.value).toBe('high');
      expect(f.scope.value).toBe('project');
      f.apply.click();
      expect(f.sent.at(-1)).toMatchObject({ operation: 'configure', role: 'advisor', scope: 'project', provider: 'fake', modelId: 'large', thinkingLevel: 'high' });
      f.respond({ data: { configuration: f.session.configuration } });
      expect(f.session.model).toBe('small');
      f.scope.value = 'global'; f.clear.click();
      expect(f.sent.at(-1)).toMatchObject({ operation: 'configure', role: 'advisor', scope: 'global', clear: true });
      expect(f.sent.at(-1)).not.toHaveProperty('provider');
    } finally { f.picker.dispose(); }
  });
  it('exposes no guessed roles on Pi or old runners and blocks all role mutations while busy', () => {
    const f = fixture();
    try {
      f.load.click(); f.respond();
      expect(f.role.options.length).toBe(1);
      expect(f.status.textContent).toContain('update/reload');
      expect(f.clear.hidden).toBe(true);
      f.session.busy = true; f.picker.sync(true);
      expect(f.clear.disabled).toBe(true); expect(f.scope.disabled).toBe(true);
    } finally { f.picker.dispose(); }
  });
  it('filters native role-only models out of session and incompatible role selections', () => {
    const f = fixture();
    try {
      f.load.click();
      f.respond({ data: { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off', roles: [
        { id: 'advisor', name: 'Advisor', configured: false, provider: null, modelId: null, thinkingLevel: null, source: 'default' },
        { id: 'image', name: 'Image generation', configured: false, provider: null, modelId: null, thinkingLevel: null, source: 'default' },
      ] }, models: [
        { provider: 'fake', id: 'small', thinkingLevels: ['off'], session: true, roles: ['advisor'] },
        { provider: 'fake', id: 'image', thinkingLevels: ['off'], session: false, roles: ['image'] },
      ] } });
      expect([...f.model.options].map(option => option.textContent)).toEqual(['fake/small']);
      f.role.value = 'image'; f.role.dispatchEvent(new Event('change'));
      expect([...f.model.options].map(option => option.textContent)).toEqual(['fake/image']);
      f.apply.click();
      expect(f.sent.at(-1)).toMatchObject({ role: 'image', provider: 'fake', modelId: 'image' });
      expect(f.sent.at(-1)).not.toHaveProperty('thinkingLevel');
    } finally { f.picker.dispose(); }
  });
  it('preserves explicit role scope across catalogue reloads and target changes', () => {
    const f = fixture();
    const data = { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off', roleStorage: 'global', roles: [
      { id: 'advisor', name: 'Advisor', configured: false, provider: null, modelId: null, thinkingLevel: null, source: 'default' },
    ] }, models: [{ provider: 'fake', id: 'small', thinkingLevels: ['off'], roles: ['advisor'], session: true }] };
    try {
      f.load.click(); f.respond({ data });
      f.role.value = 'advisor'; f.role.dispatchEvent(new Event('change'));
      f.scope.value = 'project'; f.scope.dispatchEvent(new Event('change'));
      f.role.value = ''; f.role.dispatchEvent(new Event('change'));
      f.role.value = 'advisor'; f.role.dispatchEvent(new Event('change'));
      f.load.click(); f.respond({ data });
      expect(f.scope.value).toBe('project');
      expect(f.clear.textContent).toBe('Reset project role');
      f.clear.click();
      expect(f.sent.at(-1)).toMatchObject({ operation: 'configure', role: 'advisor', scope: 'project', clear: true });
    } finally { f.picker.dispose(); }
  });
  it('can clear an unavailable role with no candidate models, but still blocks busy mutations', () => {
    const f = fixture();
    try {
      f.load.click();
      f.respond({ data: { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off', roleStorage: 'project', roles: [
        { id: 'speech', name: 'Speech', configured: true, provider: null, modelId: null, thinkingLevel: null, source: 'project' },
      ] }, models: [] } });
      f.role.value = 'speech'; f.role.dispatchEvent(new Event('change'));
      expect(f.role.disabled).toBe(false);
      expect(f.apply.disabled).toBe(true);
      expect(f.scope.disabled).toBe(false);
      expect(f.clear.disabled).toBe(false);
      f.session.busy = true; f.picker.sync(true);
      expect(f.clear.disabled).toBe(true);
      f.session.busy = false; f.picker.sync(true); f.clear.click();
      expect(f.sent.at(-1)).toMatchObject({ role: 'speech', scope: 'project', clear: true });
    } finally { f.picker.dispose(); }
  });
  it.each(['auto', 'inherit'])('preserves an existing role %s thinking selector on unchanged save', level => {
    const f = fixture();
    try {
      f.load.click();
      f.respond({ data: { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off', roleStorage: 'project', roles: [
        { id: 'advisor', name: 'Advisor', configured: true, provider: 'fake', modelId: 'small', thinkingLevel: level, source: 'project' },
      ] }, models: [{ provider: 'fake', id: 'small', thinkingLevels: ['off'], roles: ['advisor'], session: true }] } });
      f.role.value = 'advisor'; f.role.dispatchEvent(new Event('change'));
      expect(f.thinking.value).toBe(level);
      f.apply.click();
      expect(f.sent.at(-1)).toMatchObject({ role: 'advisor', provider: 'fake', modelId: 'small', thinkingLevel: level });
    } finally { f.picker.dispose(); }
  });
  it('refreshes available roles and status when the same session reconnects with an updated extension', () => {
    const f = fixture();
    try {
      f.load.click(); f.respond();
      const oldStatus = f.status.textContent;
      f.session.configuration = { ...f.session.configuration, roleStorage: 'global', roles: [
        { id: 'advisor', name: 'Advisor', configured: false, provider: null, modelId: null, thinkingLevel: null, source: 'default' },
      ] };
      f.picker.sync(true);
      expect([...f.role.options].map(option => option.value)).toEqual(['', 'advisor']);
      expect(f.role.disabled).toBe(false);
      expect(f.status.textContent).not.toBe(oldStatus);
      f.role.value = 'advisor'; f.role.dispatchEvent(new Event('change'));
      f.apply.click();
      expect(f.sent.at(-1)).toMatchObject({ operation: 'configure', role: 'advisor', scope: 'global' });
    } finally { f.picker.dispose(); }
  });
});
