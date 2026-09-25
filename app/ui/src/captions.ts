/**
 * captions.ts — live captions & notifications handler.
 * Safely tolerates headless operation when visual text captions are disabled.
 */

const MAX_CAPTIONS = 200;

export class CaptionsView {
  constructor(private container: HTMLElement | null) {}

  clear() {
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  addSystem(text: string) {
    if (!this.container) return;
    const div = document.createElement('div');
    div.className = 'caption system';
    div.dataset.from = 'system';
    div.innerHTML = `
      <span class="who"><span class="system-badge">SYS</span></span>
      <span class="text">${escape(text)}</span>
    `;
    this.container.appendChild(div);
    this.trim();
    this.scrollBottom();
  }

  add(ev: { kind: string; from: string; payload: any }, senderDisplayName?: string) {
    if (!this.container) return;
    const text = String(ev.payload?.text ?? ev.payload?.payload?.text ?? '').trim();
    if (!text) return;
    this.append(ev.kind, ev, text, senderDisplayName);
  }

  private append(kind: string, ev: { from: string; payload: any }, text: string, senderDisplayName?: string) {
    if (!this.container) return;
    const lang = String(ev.payload?.lang ?? ev.payload?.language ?? ev.payload?.payload?.lang ?? ev.payload?.payload?.language ?? '').trim().toUpperCase();
    const who = senderDisplayName || (ev.from ? ev.from.slice(0, 6) : 'Partner');

    if (kind === 'caption-partial') {
      const last = this.container.lastElementChild;
      if (last instanceof HTMLElement && last.classList.contains('caption-partial') && last.dataset.from === ev.from) {
        const textEl = last.querySelector('.text');
        if (textEl) textEl.textContent = text;
        this.scrollBottom();
        return;
      }
    }

    const div = document.createElement('div');
    div.className = `caption ${kind}`;
    div.dataset.from = ev.from || '';
    const langHtml = lang ? `<span class="lang">${escape(lang)}</span>` : '';

    div.innerHTML = `
      <span class="who">${escape(who)}</span>
      ${langHtml}
      <span class="text">${escape(text)}</span>
    `;
    this.container.appendChild(div);
    this.trim();
    this.scrollBottom();
  }

  private trim() {
    if (!this.container) return;
    while (this.container.children.length > MAX_CAPTIONS) {
      this.container.firstElementChild?.remove();
    }
  }

  private scrollBottom() {
    if (!this.container) return;
    this.container.scrollTop = this.container.scrollHeight - this.container.clientHeight;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
