// content.js — Yuuna Agent Content Script
// Handles both: chat context requests AND full agent DOM interactions

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── Existing: Chat context for normal conversation ───────────────────────
  if (request.type === "GET_CONTEXT") {
    let pageText = document.body.innerText;
    pageText = pageText.replace(/\s+/g, ' ').trim();
    const context = `
      URL: ${window.location.href}
      Title: ${document.title}
      Content Snippet: ${pageText.substring(0, 3000)}
    `;
    sendResponse({ context });
    return true;
  }

  // ── Agent: Observe ─────────────────────────────────────────────────────
  // Returns a structured snapshot of the current page for the AI to reason about
  if (request.type === "AGENT_OBSERVE") {
    try {
      const interactiveElements = [];
      const sel = 'button, input, textarea, select, a[href], [role="button"], [role="link"], [role="textbox"], [onclick]';
      const els = document.querySelectorAll(sel);

      els.forEach((el, i) => {
        if (i >= 60) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // skip invisible

        const text = (
          el.innerText ||
          el.value ||
          el.placeholder ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') || ''
        ).substring(0, 100).trim();

        const item = {
          tag: el.tagName.toLowerCase(),
          text: text,
          type: el.type || null,
          id: el.id || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          href: el.tagName === 'A' ? el.href : null,
          selector: _buildSelector(el),
        };

        if (item.text || item.placeholder || item.href) {
          interactiveElements.push(item);
        }
      });

      let pageText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();

      sendResponse({
        url: window.location.href,
        title: document.title,
        text_snippet: pageText.substring(0, 4000),
        interactive_elements: interactiveElements,
        scroll_height: document.documentElement.scrollHeight,
        scroll_position: Math.round(window.scrollY),
      });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }

  // ── Agent: Click ─────────────────────────────────────────────────────────
  if (request.type === "AGENT_CLICK") {
    try {
      const target = (request.target || '').trim();
      let el = null;

      // 1. Try as CSS selector
      if (target.startsWith('#') || target.startsWith('.') || target.includes('[')) {
        try { el = document.querySelector(target); } catch (_) {}
      }

      // 2. Try exact ID shorthand (no #)
      if (!el && !target.includes(' ')) {
        el = document.getElementById(target) || null;
      }

      // 3. Search by visible text on interactive elements
      if (!el) {
        const candidates = document.querySelectorAll(
          'button, a, [role="button"], input[type="submit"], input[type="button"], label'
        );
        const lower = target.toLowerCase();
        for (const c of candidates) {
          const cText = (c.innerText || c.value || c.getAttribute('aria-label') || '').toLowerCase();
          if (cText.includes(lower)) { el = c; break; }
        }
      }

      // 4. Generic querySelector fallback
      if (!el) {
        try { el = document.querySelector(target); } catch (_) {}
      }

      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.click();
        sendResponse({ success: true, tag: el.tagName, text: (el.innerText || '').substring(0, 60) });
      } else {
        sendResponse({ success: false, error: `Element not found: "${target}"` });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ── Agent: Type ───────────────────────────────────────────────────────────
  if (request.type === "AGENT_TYPE") {
    try {
      const { selector, text } = request;
      let el = null;

      // 1. CSS selector
      try { el = document.querySelector(selector); } catch (_) {}

      // 2. Placeholder / aria-label match
      if (!el) {
        const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea');
        const lower = selector.toLowerCase();
        for (const inp of inputs) {
          const ph = (inp.placeholder || inp.getAttribute('aria-label') || inp.name || inp.id || '').toLowerCase();
          if (ph.includes(lower)) { el = inp; break; }
        }
      }

      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();

        // Clear and set value — works for native AND React/Vue inputs
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(el, text);
        else el.value = text;

        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        sendResponse({ success: true, typed: text, into: _buildSelector(el) });
      } else {
        sendResponse({ success: false, error: `Input not found: "${selector}"` });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ── Agent: Press Enter ────────────────────────────────────────────────────
  if (request.type === "AGENT_KEY") {
    try {
      const selector = request.selector;
      let el = selector ? document.querySelector(selector) : document.activeElement;

      if (el) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown',  opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup',    opts));
        // Also try submitting a parent form
        const form = el.closest('form');
        if (form) {
          try { form.requestSubmit(); } catch (_) { form.submit(); }
        }
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No focused element' });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ── Agent: Scroll ─────────────────────────────────────────────────────────
  if (request.type === "AGENT_SCROLL") {
    try {
      const dir = (request.direction || 'down').toLowerCase();
      const vh = window.innerHeight;
      if      (dir === 'down')   window.scrollBy({ top:  vh * 0.8, behavior: 'smooth' });
      else if (dir === 'up')     window.scrollBy({ top: -vh * 0.8, behavior: 'smooth' });
      else if (dir === 'top')    window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (dir === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      sendResponse({ success: true, new_position: Math.round(window.scrollY) });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ── Agent: Extract ────────────────────────────────────────────────────────
  // Pulls structured data from the page — elements, text, prices, links
  if (request.type === "AGENT_EXTRACT") {
    try {
      const defaultSel =
        '[data-component-type="s-search-result"], ' +  // Amazon
        '.g, .tF2Cxc, ' +                              // Google results
        'article, .post, ' +                            // Blogs
        'tr, li, ' +                                    // Tables/lists
        '.price, [class*="price"], [data-price], ' +   // Prices
        '[class*="product"], [class*="result"], ' +     // Products
        '[class*="item"], [class*="card"]';             // Cards

      const selector = request.selector || defaultSel;
      const elements = document.querySelectorAll(selector);
      const results = [];
      const PRICE_RE = /[\$£€¥₩₹]?\s*\d[\d,.]*(?:\.\d{1,2})?/g;

      elements.forEach((el, i) => {
        if (i >= 60) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 3) return;

        const prices = text.match(PRICE_RE) || [];
        const links  = Array.from(el.querySelectorAll('a[href]'))
                            .slice(0, 3)
                            .map(a => ({ text: a.innerText?.trim(), href: a.href }));

        results.push({
          tag:      el.tagName.toLowerCase(),
          text:     text.substring(0, 300),
          prices:   prices.slice(0, 5),
          links:    links,
          selector: _buildSelector(el),
        });
      });

      sendResponse({ success: true, count: results.length, data: results });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  // ── Agent: Read Page ──────────────────────────────────────────────────────
  // Returns a large text blob for deep content analysis
  if (request.type === "AGENT_READ") {
    try {
      // Try to find the main content area first (avoids nav/footer noise)
      const mainEl =
        document.querySelector('article, main, [role="main"], #content, .content, .post-body') ||
        document.body;

      let text = (mainEl.innerText || '').replace(/\s+/g, ' ').trim();

      sendResponse({
        success: true,
        url:   window.location.href,
        title: document.title,
        text:  text.substring(0, 8000),
      });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  return true; // Keep message channel open for async responses
});


// ── Helper: build a short CSS selector for an element ───────────────────────
function _buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
  let sel = el.tagName.toLowerCase();
  if (el.className && typeof el.className === 'string') {
    const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
    if (cls) sel += '.' + cls;
  }
  return sel;
}
