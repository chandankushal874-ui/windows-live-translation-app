/**
 * captions.ts — live captions & translations view.
 *
 * Distinct rendering for:
 *   - partial     (interim source text, dim italic)
 *   - final       (final source caption, accent border)
 *   - translation (final translated caption, green border)
 *   - system      (room notifications, muted style)
 */
const MAX_CAPTIONS = 200;
export class CaptionsView {
    container;
    constructor(container) {
        this.container = container;
    }
    clear() {
        this.container.innerHTML = '';
    }
    addSystem(text) {
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
    add(ev, senderDisplayName) {
        const text = String(ev.payload?.text ?? ev.payload?.payload?.text ?? '').trim();
        // Ignore internal protocol lifecycle events with no spoken text (speech.started, translation.started, etc.)
        if (!text)
            return;
        this.append(ev.kind, ev, text, senderDisplayName);
    }
    append(kind, ev, text, senderDisplayName) {
        const lang = String(ev.payload?.lang ?? ev.payload?.language ?? ev.payload?.payload?.lang ?? ev.payload?.payload?.language ?? '').trim().toUpperCase();
        const who = senderDisplayName || (ev.from ? ev.from.slice(0, 6) : 'Partner');
        // For "partial" events, update the previous partial from the same speaker rather than appending
        if (kind === 'caption-partial') {
            const last = this.container.lastElementChild;
            if (last instanceof HTMLElement && last.classList.contains('caption-partial') && last.dataset.from === ev.from) {
                const textEl = last.querySelector('.text');
                if (textEl)
                    textEl.textContent = text;
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
    trim() {
        while (this.container.children.length > MAX_CAPTIONS) {
            this.container.firstElementChild?.remove();
        }
    }
    scrollBottom() {
        this.container.scrollTop = this.container.scrollHeight - this.container.clientHeight;
    }
}
function escape(s) {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
