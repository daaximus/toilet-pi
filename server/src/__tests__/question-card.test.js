// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

it('renders the question card when a snapshot carries a pending question', async () => {
  const html = readFileSync('public/index.html', 'utf8');
  document.documentElement.innerHTML = html.replace(/<script[^>]*src="\/app.js"[^>]*><\/script>/, '');
  const sockets = [];
  class FakeWS {
    static OPEN = 1;
    constructor() { this.readyState = 1; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ authenticated: true }) })));
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  await import('../../public/app.js');
  await new Promise((r) => setTimeout(r, 20));
  const ws = sockets[0];
  const deliver = (m) => ws.onmessage?.({ data: JSON.stringify(m) });
  deliver({ type: 'overview', hosts: [{ hostId: 'h', hostname: 'h', connected: true, sessions: [{ sessionGuid: 's1', sessionFile: null, sessionName: null, cwd: 'C:\\x', preview: null, updatedAt: 1, owner: 'background', busy: true, model: 'm', contextWindowTokens: null, contextTokens: null, costUsd: null, runnerStatus: 'running', queuedInputCount: 0, pendingQuestion: true }] }] });
  // Attach by clicking the session row the sidebar rendered.
  const row = document.querySelector('button.list-item');
  expect(row, 'session row rendered').toBeTruthy();
  row.click();
  deliver({ type: 'session_snapshot', session: { sessionGuid: 's1', owner: 'background', hostId: 'h', hostname: 'h', sessionFile: null, sessionName: null, cwd: 'C:\\x', model: 'm', contextWindowTokens: null, contextTokens: null, costUsd: null, busy: true, history: [], streamingText: null, streamingThinkingText: null, activeTools: [], queuedInputs: [],
    pendingQuestion: { questionId: 'q1', createdAt: 1, questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], recommended: 1 }] } } });
  await new Promise((r) => setTimeout(r, 50));
  const card = document.getElementById('question-card');
  expect(card.hidden).toBe(false);
  expect(card.textContent).toContain('Which color?');
  expect(card.querySelector('input[value="Blue"]').checked).toBe(true);
  expect(document.querySelector('.badge.question')?.textContent).toBe('requires input');
  deliver({ type: 'session_event', sessionGuid: 's1', event: { type: 'question', question: null } });
  await new Promise((r) => setTimeout(r, 300));
  expect(card.hidden).toBe(true);
  deliver({ type: 'session_event', sessionGuid: 's1', event: { type: 'question', question: { questionId: 'q2', createdAt: 2, questions: [{ id: 'a', question: 'Live?', options: [{ label: 'Yes' }], multi: true }] } } });
  await new Promise((r) => setTimeout(r, 300));
  expect(card.hidden).toBe(false);
  expect(card.textContent).toContain('Live?');
});
