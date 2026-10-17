// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendImages, createImageComposer, isImageAttachment, MAX_IMAGE_BYTES, userMessageContent, validImageAttachments } from '../../public/image-attachments.js';
import { parseClientMessage } from '../shared/protocol.js';

const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('image attachment contracts', () => {
  it('preserves the runtime image-content shape and keeps text-only input unchanged', () => {
    expect(userMessageContent('hello')).toBe('hello');
    expect(userMessageContent('', [image])).toEqual([image]);
    expect(userMessageContent('describe', [image, image])).toEqual([{ type: 'text', text: 'describe' }, image, image]);
    expect(parseClientMessage({ type: 'input', sessionGuid: 'session', text: '', images: [image] }).type).toBe('input');
    expect(parseClientMessage({ type: 'input', sessionGuid: 'session', text: '', images: [] }).type).toBe('__invalid__');
  });

  it('rejects active content, bad encoding, oversized and excessive images', () => {
    for (const bad of [{ ...image, mimeType: 'image/svg+xml' }, { ...image, data: 'javascript:alert(1)' },
      { ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]) {
      expect(isImageAttachment(bad)).toBe(false);
      expect(parseClientMessage({ type: 'input', sessionGuid: 's', text: 'x', images: [bad] }).type).toBe('__invalid__');
    }
    expect(validImageAttachments(Array(5).fill(image))).toBe(false);
    expect(isImageAttachment({ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES).toString('base64') })).toBe(true);
  });

  it('renders only validated raster data URLs without interpreting HTML', () => {
    const root = document.createElement('div');
    appendImages(root, [image, { ...image, mimeType: 'image/svg+xml' }, { ...image, data: '\" onerror=alert(1)' }]);
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(root.querySelector('[onerror], script')).toBeNull();
  });

  it('previews multiple selections, removes images, and retains existing selections on file errors', async () => {
    vi.stubGlobal('Image', class { async decode() {} });
    const picker = document.createElement('input'); picker.type = 'file';
    const button = document.createElement('button');
    const previews = document.createElement('div');
    const report = vi.fn();
    const composer = createImageComposer({ picker, button, previews, report });
    const select = async files => {
      Object.defineProperty(picker, 'files', { configurable: true, value: files });
      await picker.onchange();
    };
    await select([new File(['one'], 'one.png', { type: 'image/png' }), new File(['two'], 'two.png', { type: 'image/png' })]);
    expect(composer.getImages()).toHaveLength(2);
    expect(previews.querySelectorAll('img')).toHaveLength(2);
    previews.querySelector('button').click();
    expect(composer.getImages()).toHaveLength(1);
    await select([new File(['valid'], 'three.png', { type: 'image/png' }), new File(['bad'], 'bad.svg', { type: 'image/svg+xml' })]);
    expect(composer.getImages()).toHaveLength(1);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining('choose JPEG'), 'error');
    composer.clear();
    expect(composer.getImages()).toEqual([]);
    expect(previews.hidden).toBe(true);
  });
});
