// NanoClaw Chrome Extension - Content Script
// Injected into every page to provide DOM interaction capabilities.
// Receives commands from the background service worker and executes them.

(() => {
  // Prevent double-injection
  if (window.__nanoclaw_content_loaded) return;
  window.__nanoclaw_content_loaded = true;

  // --- Element Resolution ---

  function resolveElement(params) {
    if (!params) throw new Error('No selector params provided');

    // By CSS selector
    if (params.selector) {
      const el = document.querySelector(params.selector);
      if (!el) throw new Error(`Element not found: ${params.selector}`);
      return el;
    }

    // By XPath
    if (params.xpath) {
      const result = document.evaluate(
        params.xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      if (!result.singleNodeValue) throw new Error(`XPath not found: ${params.xpath}`);
      return result.singleNodeValue;
    }

    // By ref (snapshot reference like @e1)
    if (params.ref) {
      const refNum = typeof params.ref === 'string'
        ? parseInt(params.ref.replace('@e', ''))
        : params.ref;
      const elements = window.__nanoclaw_snapshot_elements;
      if (!elements || !elements[refNum]) {
        throw new Error(`Ref ${params.ref} not found. Run snapshot first.`);
      }
      return elements[refNum];
    }

    // By text content
    if (params.text) {
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node.offsetParent === null && getComputedStyle(node).position !== 'fixed') {
              return NodeFilter.FILTER_REJECT;
            }
            const text = node.textContent?.trim();
            if (text && text.includes(params.text)) {
              // Prefer leaf-like elements
              const childElementsWithText = Array.from(node.children).filter(
                c => c.textContent?.trim().includes(params.text)
              );
              if (childElementsWithText.length === 0) {
                return NodeFilter.FILTER_ACCEPT;
              }
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );
      const el = walker.nextNode();
      if (!el) throw new Error(`Element with text "${params.text}" not found`);
      return el;
    }

    // By coordinates
    if (params.x !== undefined && params.y !== undefined) {
      const el = document.elementFromPoint(params.x, params.y);
      if (!el) throw new Error(`No element at (${params.x}, ${params.y})`);
      return el;
    }

    throw new Error('No valid selector: use selector, xpath, ref, text, or x/y');
  }

  function scrollIntoViewIfNeeded(el) {
    const rect = el.getBoundingClientRect();
    if (
      rect.top < 0 || rect.bottom > window.innerHeight ||
      rect.left < 0 || rect.right > window.innerWidth
    ) {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    }
  }

  // --- Simulate Human-Like Events ---

  function simulateMouseEvent(el, eventType, options = {}) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const event = new MouseEvent(eventType, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      screenX: x + window.screenX, screenY: y + window.screenY,
      button: options.button || 0,
      detail: options.detail || 1,
      ...options
    });
    el.dispatchEvent(event);
  }

  function simulateClick(el) {
    scrollIntoViewIfNeeded(el);
    simulateMouseEvent(el, 'pointerover');
    simulateMouseEvent(el, 'pointerenter');
    simulateMouseEvent(el, 'mouseover');
    simulateMouseEvent(el, 'mouseenter');
    simulateMouseEvent(el, 'pointerdown');
    simulateMouseEvent(el, 'mousedown');
    el.focus?.();
    simulateMouseEvent(el, 'pointerup');
    simulateMouseEvent(el, 'mouseup');
    simulateMouseEvent(el, 'click');
  }

  function simulateDoubleClick(el) {
    scrollIntoViewIfNeeded(el);
    simulateClick(el);
    simulateMouseEvent(el, 'click', { detail: 2 });
    simulateMouseEvent(el, 'dblclick', { detail: 2 });
  }

  function simulateRightClick(el) {
    scrollIntoViewIfNeeded(el);
    simulateMouseEvent(el, 'contextmenu', { button: 2 });
  }

  function simulateTyping(el, text) {
    el.focus?.();
    for (const char of text) {
      const keyDown = new KeyboardEvent('keydown', {
        key: char, code: `Key${char.toUpperCase()}`,
        bubbles: true, cancelable: true
      });
      el.dispatchEvent(keyDown);

      const keyPress = new KeyboardEvent('keypress', {
        key: char, code: `Key${char.toUpperCase()}`,
        bubbles: true, cancelable: true
      });
      el.dispatchEvent(keyPress);

      // For input/textarea, use InputEvent
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
        const inputEvent = new InputEvent('input', {
          inputType: 'insertText', data: char,
          bubbles: true, cancelable: true
        });
        if (el.isContentEditable) {
          document.execCommand('insertText', false, char);
        } else {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          el.value = el.value.substring(0, start) + char + el.value.substring(end);
          el.selectionStart = el.selectionEnd = start + 1;
          el.dispatchEvent(inputEvent);
        }
      }

      const keyUp = new KeyboardEvent('keyup', {
        key: char, code: `Key${char.toUpperCase()}`,
        bubbles: true, cancelable: true
      });
      el.dispatchEvent(keyUp);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --- Snapshot: Interactive Elements ---

  function buildSnapshot(params) {
    const interactive = params?.interactive !== false;
    const elements = [];
    const refs = {};
    let refIndex = 0;

    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      // Skip hidden elements
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed' && getComputedStyle(el).position !== 'sticky') {
        continue;
      }

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const ariaLabel = el.getAttribute('aria-label');
      const type = el.getAttribute('type');
      const href = el.getAttribute('href');
      const text = el.textContent?.trim().substring(0, 200);
      const placeholder = el.getAttribute('placeholder');
      const name = el.getAttribute('name');
      const id = el.id;

      let isInteractive = false;
      let elementInfo = {};

      // Clickable elements
      if (tag === 'a' || tag === 'button' || role === 'button' || role === 'link' ||
          role === 'menuitem' || role === 'tab' || role === 'option' ||
          el.onclick || el.getAttribute('tabindex') !== null ||
          getComputedStyle(el).cursor === 'pointer') {
        isInteractive = true;
        elementInfo.clickable = true;
      }

      // Form elements
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        isInteractive = true;
        elementInfo.formElement = true;
        elementInfo.type = type || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text');
        if (el.value) elementInfo.value = el.value.substring(0, 200);
        if (el.checked !== undefined) elementInfo.checked = el.checked;
        if (tag === 'select') {
          elementInfo.options = Array.from(el.options).map(o => ({
            value: o.value,
            text: o.text,
            selected: o.selected
          }));
        }
      }

      // Checkboxes and radios
      if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' ||
          role === 'switch') {
        isInteractive = true;
        elementInfo.checked = el.checked || el.getAttribute('aria-checked') === 'true';
      }

      if (!interactive || isInteractive) {
        const refId = `@e${refIndex}`;
        refs[refIndex] = el;

        const rect = el.getBoundingClientRect();
        const info = {
          ref: refId,
          tag,
          ...elementInfo
        };

        if (text && text.length > 0) info.text = text;
        if (ariaLabel) info.ariaLabel = ariaLabel;
        if (href) info.href = href;
        if (placeholder) info.placeholder = placeholder;
        if (name) info.name = name;
        if (id) info.id = id;
        if (role) info.role = role;

        info.bounds = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        };

        elements.push(info);
        refIndex++;
      }
    }

    // Store refs for later use
    window.__nanoclaw_snapshot_elements = refs;

    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      totalElements: refIndex,
      elements
    };
  }

  // --- Action Handlers ---

  const handlers = {
    click(params) {
      const el = resolveElement(params);
      simulateClick(el);
      // Also click natively for links and buttons
      if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.type === 'submit') {
        el.click();
      }
      return { clicked: true, tag: el.tagName.toLowerCase() };
    },

    double_click(params) {
      const el = resolveElement(params);
      simulateDoubleClick(el);
      return { doubleClicked: true };
    },

    right_click(params) {
      const el = resolveElement(params);
      simulateRightClick(el);
      return { rightClicked: true };
    },

    type(params) {
      const el = resolveElement(params);
      scrollIntoViewIfNeeded(el);
      simulateTyping(el, params.text);
      return { typed: true, length: params.text.length };
    },

    fill(params) {
      const el = resolveElement(params);
      scrollIntoViewIfNeeded(el);
      el.focus?.();
      // Clear first
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      // Type new value
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = params.text;
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: params.text, bubbles: true
        }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = params.text;
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: params.text, bubbles: true
        }));
      }
      return { filled: true, value: params.text };
    },

    clear(params) {
      const el = resolveElement(params);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      return { cleared: true };
    },

    select(params) {
      const el = resolveElement(params);
      if (el.tagName !== 'SELECT') throw new Error('Element is not a <select>');
      const option = Array.from(el.options).find(
        o => o.value === params.value || o.text === params.value
      );
      if (!option) throw new Error(`Option "${params.value}" not found`);
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true, value: option.value, text: option.text };
    },

    check(params) {
      const el = resolveElement(params);
      if (!el.checked) {
        simulateClick(el);
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { checked: true };
    },

    uncheck(params) {
      const el = resolveElement(params);
      if (el.checked) {
        simulateClick(el);
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { unchecked: true };
    },

    hover(params) {
      const el = resolveElement(params);
      scrollIntoViewIfNeeded(el);
      simulateMouseEvent(el, 'pointerover');
      simulateMouseEvent(el, 'pointerenter');
      simulateMouseEvent(el, 'mouseover');
      simulateMouseEvent(el, 'mouseenter');
      return { hovered: true };
    },

    focus(params) {
      const el = resolveElement(params);
      el.focus();
      return { focused: true };
    },

    blur(params) {
      const el = resolveElement(params);
      el.blur();
      return { blurred: true };
    },

    press_key(params) {
      const target = params.selector ? resolveElement(params) : document.activeElement || document.body;
      const key = params.key;
      const modifiers = {
        ctrlKey: params.ctrl || false,
        shiftKey: params.shift || false,
        altKey: params.alt || false,
        metaKey: params.meta || false
      };

      target.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true, ...modifiers
      }));
      target.dispatchEvent(new KeyboardEvent('keypress', {
        key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true, ...modifiers
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true, ...modifiers
      }));
      return { pressed: key };
    },

    scroll(params) {
      const x = params.x || 0;
      const y = params.y || 0;
      if (params.selector) {
        const el = resolveElement(params);
        el.scrollBy({ left: x, top: y, behavior: 'smooth' });
      } else {
        window.scrollBy({ left: x, top: y, behavior: 'smooth' });
      }
      return { scrolled: true, x, y };
    },

    scroll_to_element(params) {
      const el = resolveElement(params);
      el.scrollIntoView({ behavior: 'smooth', block: params.block || 'center' });
      return { scrolledTo: true };
    },

    drag_and_drop(params) {
      const source = resolveElement({ selector: params.sourceSelector || params.source });
      const target = resolveElement({ selector: params.targetSelector || params.target });
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();

      const dataTransfer = new DataTransfer();

      source.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, dataTransfer,
        clientX: sourceRect.x + sourceRect.width / 2,
        clientY: sourceRect.y + sourceRect.height / 2
      }));
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, dataTransfer,
        clientX: targetRect.x + targetRect.width / 2,
        clientY: targetRect.y + targetRect.height / 2
      }));
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true, dataTransfer,
        clientX: targetRect.x + targetRect.width / 2,
        clientY: targetRect.y + targetRect.height / 2
      }));
      source.dispatchEvent(new DragEvent('dragend', {
        bubbles: true, dataTransfer
      }));

      return { dragged: true };
    },

    upload_file(params) {
      // This creates a synthetic file and sets it on a file input
      const el = resolveElement(params);
      if (el.tagName !== 'INPUT' || el.type !== 'file') {
        throw new Error('Element is not a file input');
      }
      // We can't actually set files programmatically due to security,
      // but we can trigger a click to open the file dialog
      el.click();
      return { openedFileDialog: true };
    },

    // --- Data Extraction ---

    snapshot(params) {
      return buildSnapshot(params);
    },

    get_text(params) {
      if (params?.selector) {
        const el = resolveElement(params);
        return { text: el.textContent?.trim() };
      }
      return { text: document.body.innerText };
    },

    get_html(params) {
      if (params?.selector) {
        const el = resolveElement(params);
        return { html: params.outer ? el.outerHTML : el.innerHTML };
      }
      return { html: document.documentElement.outerHTML };
    },

    get_attribute(params) {
      const el = resolveElement(params);
      return { value: el.getAttribute(params.attribute) };
    },

    get_value(params) {
      const el = resolveElement(params);
      return { value: el.value };
    },

    get_styles(params) {
      const el = resolveElement(params);
      const computed = getComputedStyle(el);
      const styles = {};
      const props = params.properties || ['color', 'backgroundColor', 'fontSize', 'display', 'visibility', 'opacity', 'position'];
      for (const prop of props) {
        styles[prop] = computed.getPropertyValue(prop) || computed[prop];
      }
      return { styles };
    },

    get_bounding_box(params) {
      const el = resolveElement(params);
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y,
        width: rect.width, height: rect.height,
        top: rect.top, right: rect.right,
        bottom: rect.bottom, left: rect.left
      };
    },

    query_selector(params) {
      const el = document.querySelector(params.selector);
      if (!el) return { found: false };
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().substring(0, 500),
        attributes: getElementAttributes(el)
      };
    },

    query_selector_all(params) {
      const elements = document.querySelectorAll(params.selector);
      const limit = params.limit || 100;
      return {
        count: elements.length,
        elements: Array.from(elements).slice(0, limit).map(el => ({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 200),
          attributes: getElementAttributes(el)
        }))
      };
    },

    get_table_data(params) {
      const el = resolveElement(params);
      if (el.tagName !== 'TABLE') throw new Error('Element is not a <table>');
      const rows = [];
      for (const tr of el.rows) {
        const cells = [];
        for (const td of tr.cells) {
          cells.push(td.textContent?.trim());
        }
        rows.push(cells);
      }
      return { rows, rowCount: rows.length, colCount: rows[0]?.length || 0 };
    },

    get_links(params) {
      const links = document.querySelectorAll('a[href]');
      const limit = params?.limit || 200;
      return {
        count: links.length,
        links: Array.from(links).slice(0, limit).map(a => ({
          text: a.textContent?.trim().substring(0, 100),
          href: a.href,
          target: a.target || '_self'
        }))
      };
    },

    get_forms(params) {
      const forms = document.querySelectorAll('form');
      return {
        count: forms.length,
        forms: Array.from(forms).map(form => ({
          action: form.action,
          method: form.method,
          id: form.id,
          fields: Array.from(form.elements).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type,
            name: el.name,
            id: el.id,
            value: el.value?.substring(0, 200),
            placeholder: el.placeholder,
            required: el.required
          }))
        }))
      };
    },

    get_page_info() {
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        scrollPosition: { x: window.scrollX, y: window.scrollY },
        readyState: document.readyState,
        characterSet: document.characterSet,
        contentType: document.contentType
      };
    },

    // --- Wait ---

    async wait_for_element(params) {
      const timeout = params.timeout || 10000;
      const interval = params.interval || 200;
      const start = Date.now();

      return new Promise((resolve) => {
        const check = () => {
          const el = document.querySelector(params.selector);
          if (el) {
            resolve({ found: true, elapsed: Date.now() - start });
          } else if (Date.now() - start > timeout) {
            resolve({ found: false, error: `Timeout waiting for ${params.selector}` });
          } else {
            setTimeout(check, interval);
          }
        };
        check();
      });
    },

    async wait_for_text(params) {
      const timeout = params.timeout || 10000;
      const interval = params.interval || 200;
      const start = Date.now();

      return new Promise((resolve) => {
        const check = () => {
          const found = document.body.innerText.includes(params.text);
          if (found) {
            resolve({ found: true, elapsed: Date.now() - start });
          } else if (Date.now() - start > timeout) {
            resolve({ found: false, error: `Timeout waiting for text "${params.text}"` });
          } else {
            setTimeout(check, interval);
          }
        };
        check();
      });
    },

    // --- Storage ---

    get_local_storage(params) {
      if (params?.key) {
        return { value: localStorage.getItem(params.key) };
      }
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        items[key] = localStorage.getItem(key);
      }
      return { items };
    },

    set_local_storage(params) {
      localStorage.setItem(params.key, params.value);
      return { set: true };
    },

    // --- Clipboard ---

    async copy_to_clipboard(params) {
      await navigator.clipboard.writeText(params.text);
      return { copied: true };
    },

    async read_clipboard() {
      const text = await navigator.clipboard.readText();
      return { text };
    }
  };

  function getElementAttributes(el) {
    const attrs = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }
    return attrs;
  }

  // --- Message Listener ---

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const { action, params } = msg;

    if (!handlers[action]) {
      sendResponse({ success: false, error: `Unknown action: ${action}` });
      return;
    }

    try {
      const result = handlers[action](params || {});

      // Handle async actions
      if (result && typeof result.then === 'function') {
        result.then(
          data => sendResponse({ success: true, data }),
          err => sendResponse({ success: false, error: err.message })
        );
        return true; // Keep channel open for async
      }

      sendResponse({ success: true, data: result });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  });
})();
