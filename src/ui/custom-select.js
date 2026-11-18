'use strict';

window.ccSelects = (() => {
  const controls = new Map();
  let opened = null;

  function enhance(select) {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    wrapper.dataset.select = select.id;
    select.before(wrapper);
    wrapper.append(select);
    select.classList.add('custom-select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const button = document.createElement('button');
    button.type = 'button';
    button.id = select.id + '-button';
    button.className = 'select-button';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', select.id + '-listbox');
    const label = document.createElement('span');
    label.className = 'select-value';
    const chevron = document.createElement('span');
    chevron.className = 'select-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    button.append(label, chevron);
    wrapper.append(button);

    const labels = [...select.labels];
    labels.forEach((element, index) => {
      element.id ||= select.id + '-label-' + index;
      element.htmlFor = button.id;
    });
    const popup = document.createElement('div');
    popup.id = select.id + '-listbox';
    popup.className = 'select-listbox';
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('popover', 'manual');
    // A popup within a modal dialog must remain inside that dialog's active subtree.
    (select.closest('dialog') || document.body).append(popup);

    let options = [];
    let activeIndex = -1;
    let search = '';
    let searchTimer;
    function position() {
      const rect = button.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, select.id === 'language-select' ? 178 : 190), innerWidth - 24);
      const height = Math.min(popup.scrollHeight, 280);
      const below = innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const placeAbove = below < height && above > below;
      const available = Math.max(80, placeAbove ? above : below);
      popup.style.width = width + 'px';
      popup.style.maxHeight = Math.min(280, available) + 'px';
      popup.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px';
      popup.style.top = (placeAbove ? Math.max(12, rect.top - Math.min(height, available) - 6) : rect.bottom + 6) + 'px';
    }
    function activate(index) {
      activeIndex = index;
      [...popup.children].forEach((option, i) => option.classList.toggle('is-active', i === index));
      const option = popup.children[index];
      if (option) {
        button.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
      } else button.removeAttribute('aria-activedescendant');
    }
    function close() {
      if (opened !== control) return;
      popup.hidePopover();
      opened = null;
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      wrapper.classList.remove('is-open');
      clearTimeout(searchTimer);
      search = '';
    }
    function open() {
      if (button.disabled || !options.length) return;
      opened?.close();
      sync();
      opened = control;
      popup.showPopover();
      button.setAttribute('aria-expanded', 'true');
      wrapper.classList.add('is-open');
      position();
      activate(options.findIndex(option => option.index === select.selectedIndex));
    }
    function choose(index) {
      if (!options[index] || options[index].disabled) return;
      select.value = options[index].value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      sync();
      button.focus();
    }
    function sync() {
      options = [...select.options].map((option, index) => ({
        value: option.value, text: option.textContent, disabled: option.disabled, index
      }));
      label.textContent = select.selectedOptions[0]?.textContent || '—';
      button.disabled = select.disabled || !options.length;
      if (button.disabled) close();
      const accessibleName = select.getAttribute('aria-label');
      if (accessibleName) button.setAttribute('aria-label', accessibleName);
      else if (labels.length) button.setAttribute('aria-labelledby', labels.map(item => item.id).join(' '));
      if (select.title) button.title = select.title;
      const describedBy = select.getAttribute('aria-describedby');
      if (describedBy) button.setAttribute('aria-describedby', describedBy);
      popup.setAttribute('aria-label', accessibleName || labels.map(item => item.textContent).join(' ') || label.textContent);
      popup.replaceChildren(...options.map((option, index) => {
        const row = document.createElement('div');
        row.id = popup.id + '-' + index;
        row.className = 'select-option';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.index === select.selectedIndex));
        if (option.disabled) row.setAttribute('aria-disabled', 'true');
        const text = document.createElement('span');
        text.textContent = option.text;
        const tick = document.createElement('span');
        tick.className = 'select-tick';
        tick.setAttribute('aria-hidden', 'true');
        row.append(text, tick);
        row.onpointermove = () => { if (!option.disabled) activate(index); };
        row.onpointerdown = event => event.preventDefault();
        row.onclick = () => choose(index);
        return row;
      }));
      if (opened === control) {
        position();
        activate(Math.max(0, Math.min(activeIndex, options.length - 1)));
      }
    }
    function move(step, edge) {
      const enabled = options.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0);
      if (!enabled.length) return;
      const current = enabled.indexOf(activeIndex);
      const next = edge === 'first' ? enabled[0] : edge === 'last' ? enabled.at(-1)
        : enabled[(current + step + enabled.length) % enabled.length];
      activate(next);
    }
    button.onclick = () => opened === control ? close() : open();
    button.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (opened !== control) {
          open();
          if (event.key === 'Home' || event.key === 'End') move(0, event.key === 'Home' ? 'first' : 'last');
        } else move(event.key === 'ArrowUp' ? -1 : 1, event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (opened === control) choose(activeIndex);
        else open();
      } else if (event.key === 'Escape' && opened === control) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') close();
      else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (opened !== control) open();
        clearTimeout(searchTimer);
        search += event.key.toLocaleLowerCase();
        const index = options.findIndex(item => !item.disabled && item.text.toLocaleLowerCase().startsWith(search));
        if (index >= 0) activate(index);
        searchTimer = setTimeout(() => { search = ''; }, 700);
      }
    };
    select.addEventListener('change', sync);
    select.addEventListener('invalid', () => button.focus());
    new MutationObserver(sync).observe(select, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['disabled', 'selected', 'value', 'aria-label', 'aria-describedby', 'title']
    });
    const control = { sync, close, position, button, popup, wrapper };
    controls.set(select, control);
    sync();
  }

  document.querySelectorAll('select').forEach(enhance);
  document.addEventListener('pointerdown', event => {
    if (opened && !opened.wrapper.contains(event.target) && !opened.popup.contains(event.target)) opened.close();
  }, true);
  document.addEventListener('focusin', event => {
    if (opened && !opened.wrapper.contains(event.target) && !opened.popup.contains(event.target)) opened.close();
  });
  window.addEventListener('blur', () => opened?.close());
  window.addEventListener('resize', () => opened?.position());
  document.addEventListener('scroll', event => {
    if (opened && !opened.popup.contains(event.target)) opened.position();
  }, true);
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => opened?.close()));
  return { refresh: () => controls.forEach(control => control.sync()), close: () => opened?.close() };
})();
