class VirtualList {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      itemHeight: null,
      estimatedItemHeight: 50,
      estimatedHeaderHeight: 40,
      buffer: 5,
      threshold: 200,
      selectionMode: 'none',
      defaultSelectedKeys: null,
      defaultFocusedKey: null,
      defaultCollapsedGroups: null,
      renderItem: null,
      renderGroupHeader: null,
      renderStickyHeader: null,
      onLoadMore: null,
      onVisibleRangeChange: null,
      onStickyGroupChange: null,
      onSelectionChange: null,
      onFocusChange: null,
      onGroupCollapseChange: null,
      getItemKey: (item) => (item && item.id != null) ? item.id : null,
      getGroupKey: (group) => (group && group.groupKey != null) ? group.groupKey : (group ? group.group : null),
      ...options
    };

    this.data = [];
    this._originalData = null;
    this.flatItems = [];
    this.heightsByKey = new Map();
    this.offsets = [];
    this.keyToFlatIndex = new Map();
    this.scrollTop = 0;
    this.visibleStartIndex = -1;
    this.visibleEndIndex = -1;
    this.isGrouped = false;
    this.isLoading = false;
    this.hasMore = true;
    this.anchor = null;
    this.currentStickyGroupKey = null;
    this._suppressScrollEvent = false;
    this._rafId = null;

    this._keyRegistry = new Map();
    this.selectedKeys = new Set();
    this.focusedKey = null;
    this._lastRangeSelectedKey = null;
    this.collapsedGroups = new Set();
    this._stateVersion = 0;
    this._lastRenderedStateVersion = -1;

    if (this.options.defaultSelectedKeys) {
      const arr = Array.isArray(this.options.defaultSelectedKeys)
        ? this.options.defaultSelectedKeys
        : (this.options.defaultSelectedKeys instanceof Set ? [...this.options.defaultSelectedKeys] : []);
      this.selectedKeys = new Set(arr.map(k => this._toStrKey(k)));
    }
    if (this.options.defaultFocusedKey != null) {
      this.focusedKey = this._toStrKey(this.options.defaultFocusedKey);
    }
    if (this.options.defaultCollapsedGroups) {
      const arr = Array.isArray(this.options.defaultCollapsedGroups)
        ? this.options.defaultCollapsedGroups
        : (this.options.defaultCollapsedGroups instanceof Set ? [...this.options.defaultCollapsedGroups] : []);
      this.collapsedGroups = new Set(arr.map(k => this._toStrKey(k)));
    }

    this._init();
  }

  _init() {
    this._setupDOM();
    this._setupResizeObserver();
    this._bindEvents();
  }

  _setupDOM() {
    this.container.style.overflow = 'auto';
    this.container.style.position = 'relative';
    this.container.style.willChange = 'transform';
    this.container.setAttribute('tabindex', '0');
    this.container.style.outline = 'none';

    this.scrollContent = document.createElement('div');
    this.scrollContent.style.position = 'relative';
    this.scrollContent.style.width = '100%';

    this.itemsContainer = document.createElement('div');
    this.itemsContainer.style.position = 'absolute';
    this.itemsContainer.style.top = '0';
    this.itemsContainer.style.left = '0';
    this.itemsContainer.style.width = '100%';

    this.stickyHeader = document.createElement('div');
    this.stickyHeader.style.position = 'sticky';
    this.stickyHeader.style.top = '0';
    this.stickyHeader.style.zIndex = '10';
    this.stickyHeader.style.pointerEvents = 'none';
    this.stickyHeader.style.display = 'none';

    this.scrollContent.appendChild(this.itemsContainer);
    this.container.appendChild(this.stickyHeader);
    this.container.appendChild(this.scrollContent);
  }

  _setupResizeObserver() {
    if (this.options.itemHeight !== null) {
      this.resizeObserver = null;
      return;
    }

    this.resizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = entry.target.dataset.key;
        const height = entry.contentRect.height;
        if (key && this.heightsByKey.get(key) !== height) {
          this.heightsByKey.set(key, height);
          changed = true;
        }
      }
      if (changed) {
        this._captureAnchor();
        this._scheduleUpdate(true);
      }
    });
  }

  _bindEvents() {
    this._onScroll = this._onScroll.bind(this);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });

    this._onContainerResize = this._onContainerResize.bind(this);
    this.containerResizeObserver = new ResizeObserver(this._onContainerResize);
    this.containerResizeObserver.observe(this.container);

    this._onKeyDown = this._onKeyDown.bind(this);
    this.container.addEventListener('keydown', this._onKeyDown);

    this._onMouseDown = this._onMouseDown.bind(this);
    this.itemsContainer.addEventListener('mousedown', this._onMouseDown);
    this.stickyHeader.addEventListener('mousedown', (e) => {
      const target = e.target.closest('[data-group-key]');
      if (target) {
        const gk = target.dataset.groupKey;
        if (gk != null && gk !== '') this.toggleGroupCollapse(gk);
      }
    });
  }

  _onMouseDown(e) {
    const targetEl = e.target.closest('[data-key]');
    if (!targetEl) return;
    const key = targetEl.dataset.key;
    const type = targetEl.dataset.type;
    if (!key) return;

    if (type === 'header') {
      const flatIdx = this.keyToFlatIndex.get(key);
      if (flatIdx != null) {
        const flat = this.flatItems[flatIdx];
        if (flat && flat.type === 'header') this.toggleGroupCollapse(flat._groupKey);
      }
      return;
    }

    const itemKey = this._extractItemKeyFromFull(key);
    if (itemKey == null) return;

    this._applySelectionByPointer(itemKey, e);
    this._setFocusedItem(itemKey);
    this._scheduleRender();
  }

  _applySelectionByPointer(itemKey, e) {
    if (this.options.selectionMode === 'none') return;
    if (e.shiftKey && this.options.selectionMode === 'multiple' && this._lastRangeSelectedKey != null) {
      this._selectRange(this._lastRangeSelectedKey, itemKey);
    } else if (e.ctrlKey || e.metaKey) {
      this.toggleItemSelection(itemKey);
    } else {
      this.setSelectedItem(itemKey);
    }
  }

  _toStrKey(k) {
    if (k == null) return null;
    return String(k);
  }

  _origKey(strKey) {
    if (strKey == null) return null;
    if (this._keyRegistry.has(strKey)) return this._keyRegistry.get(strKey);
    return strKey;
  }

  _registerKey(original) {
    if (original == null) return null;
    const s = String(original);
    if (!this._keyRegistry.has(s)) this._keyRegistry.set(s, original);
    return s;
  }

  _extractItemKeyFromFull(fullKey) {
    if (typeof fullKey !== 'string') return null;
    if (fullKey.startsWith('__item_')) {
      const raw = fullKey.slice('__item_'.length);
      return raw;
    }
    return null;
  }

  _onKeyDown(e) {
    const mode = this.options.selectionMode;
    const hasFocus = this.focusedKey != null;
    if (mode === 'none' && !hasFocus) return;

    const key = e.key;
    if (['ArrowUp','ArrowDown','Home','End','PageUp','PageDown',' ','Enter'].indexOf(key) < 0) return;

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      const step = key === 'ArrowUp' ? -1 : 1;
      const oldFocusedKey = this.focusedKey;
      const nextItemKey = this._findNextItemKey(this.focusedKey, step, true);
      if (nextItemKey == null) return;
      if (e.shiftKey && mode === 'multiple' && oldFocusedKey != null) {
        this._selectRange(oldFocusedKey, nextItemKey);
      }
      this._setFocusedItem(nextItemKey, { updateAnchor: !e.shiftKey });
      const full = `__item_${nextItemKey}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) this._scrollItemIntoViewIfNeeded(idx);
      this._scheduleRender();
      return;
    }

    if (key === 'Home' || key === 'End') {
      e.preventDefault();
      const oldFocusedKey = this.focusedKey;
      const targetKey = this._findEdgeItemKey(key === 'Home' ? 'first' : 'last');
      if (targetKey == null) return;
      if (e.shiftKey && mode === 'multiple' && hasFocus && oldFocusedKey != null) {
        this._selectRange(oldFocusedKey, targetKey);
      }
      this._setFocusedItem(targetKey, { updateAnchor: !e.shiftKey });
      const full = `__item_${targetKey}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        this._suppressScrollEvent = true;
        if (key === 'Home') {
          this.container.scrollTop = 0;
          this.scrollTop = 0;
        } else {
          const bottom = Math.max(0, this.totalHeight - this.container.clientHeight);
          this.container.scrollTop = bottom;
          this.scrollTop = bottom;
        }
        this._captureAnchor();
        this._scrollItemIntoViewIfNeeded(idx);
      }
      this._scheduleRender();
      return;
    }

    if (key === 'PageUp' || key === 'PageDown') {
      e.preventDefault();
      const oldFocusedKey = this.focusedKey;
      const pageSize = Math.max(1, Math.floor(this.container.clientHeight / (this.options.itemHeight || this.options.estimatedItemHeight)));
      const step = key === 'PageUp' ? -pageSize : pageSize;
      const nextItemKey = this._findNextItemKey(this.focusedKey, step, true);
      if (nextItemKey == null) {
        this._suppressScrollEvent = true;
        const delta = this.container.clientHeight * (key === 'PageUp' ? -1 : 1);
        const t = Math.max(0, Math.min(this.totalHeight, this.container.scrollTop + delta));
        this.container.scrollTop = t;
        this.scrollTop = t;
        this._captureAnchor();
        this._scheduleRender();
        return;
      }
      if (e.shiftKey && mode === 'multiple' && hasFocus && oldFocusedKey != null) {
        this._selectRange(oldFocusedKey, nextItemKey);
      }
      this._setFocusedItem(nextItemKey, { updateAnchor: !e.shiftKey });
      const full = `__item_${nextItemKey}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        this._suppressScrollEvent = true;
        const desired = this.offsets[idx] - this.container.clientHeight / 2;
        const t = Math.max(0, Math.min(this.totalHeight, desired));
        this.container.scrollTop = t;
        this.scrollTop = t;
        this._captureAnchor();
        this._scheduleRender();
      }
      return;
    }

    if ((key === ' ' || key === 'Enter') && hasFocus && mode !== 'none') {
      e.preventDefault();
      if (mode === 'single') this.setSelectedItem(this.focusedKey);
      else this.toggleItemSelection(this.focusedKey);
    }
  }

  _findNextItemKey(fromKey, step, autoExpand) {
    let idx = -1;
    if (fromKey != null) {
      const full = `__item_${fromKey}`;
      idx = this.keyToFlatIndex.get(full) != null ? this.keyToFlatIndex.get(full) : -1;
    }

    if (idx === -1) {
      if (step > 0) return this._findEdgeItemKey('first');
      else return this._findEdgeItemKey('last');
    }

    const dir = step > 0 ? 1 : -1;
    const abs = Math.abs(step);

    let currentIdx = idx;
    let count = 0;
    while (count < abs) {
      let nextIdx = currentIdx + dir;
      while (nextIdx >= 0 && nextIdx < this.flatItems.length) {
        const flat = this.flatItems[nextIdx];
        if (flat.type === 'item') {
          currentIdx = nextIdx;
          break;
        }
        if (flat.type === 'header' && autoExpand && this.collapsedGroups.has(flat._groupKey)) {
          this._expandGroupSilent(flat._groupKey);
          nextIdx = currentIdx + dir;
          continue;
        }
        nextIdx += dir;
      }
      if (nextIdx < 0 || nextIdx >= this.flatItems.length) {
        if (this.flatItems[currentIdx] && this.flatItems[currentIdx].type === 'item') return this.flatItems[currentIdx]._itemKey;
        return null;
      }
      count++;
    }
    if (this.flatItems[currentIdx] && this.flatItems[currentIdx].type === 'item') {
      return this.flatItems[currentIdx]._itemKey;
    }
    return null;
  }

  _findEdgeItemKey(edge) {
    if (this.flatItems.length === 0) return null;
    if (edge === 'first') {
      for (let i = 0; i < this.flatItems.length; i++) {
        if (this.flatItems[i].type === 'item') return this.flatItems[i]._itemKey;
      }
    } else {
      for (let i = this.flatItems.length - 1; i >= 0; i--) {
        if (this.flatItems[i].type === 'item') return this.flatItems[i]._itemKey;
      }
    }
    return null;
  }

  _expandGroupSilent(groupKey) {
    if (!this.collapsedGroups.has(groupKey)) return;
    this.collapsedGroups.delete(groupKey);
    this.flatItems = this._flattenData(this.data);
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
  }

  _scrollItemIntoViewIfNeeded(flatIdx) {
    if (flatIdx < 0 || flatIdx >= this.flatItems.length) return;
    const itemOffset = this.offsets[flatIdx];
    const itemHeight = this._getHeightByKey(this.flatItems[flatIdx]._key, this.flatItems[flatIdx]);
    const viewportTop = this.container.scrollTop;
    const viewportBottom = viewportTop + this.container.clientHeight;
    const stickyH = this.stickyHeader.style.display !== 'none' ? this.stickyHeader.offsetHeight : 0;

    if (itemOffset < viewportTop + stickyH) {
      const newTop = Math.max(0, itemOffset - stickyH);
      this._suppressScrollEvent = true;
      this.container.scrollTop = newTop;
      this.scrollTop = newTop;
      this._captureAnchor();
      this._scheduleRender();
    } else if (itemOffset + itemHeight > viewportBottom) {
      const newTop = itemOffset + itemHeight - this.container.clientHeight;
      this._suppressScrollEvent = true;
      this.container.scrollTop = newTop;
      this.scrollTop = newTop;
      this._captureAnchor();
      this._scheduleRender();
    }
  }

  _selectRange(fromKey, toKey) {
    const fromFull = `__item_${this._toStrKey(fromKey)}`;
    const toFull = `__item_${this._toStrKey(toKey)}`;
    const idx1 = this.keyToFlatIndex.get(fromFull);
    const idx2 = this.keyToFlatIndex.get(toFull);
    if (idx1 == null || idx2 == null) return;

    const [a, b] = idx1 <= idx2 ? [idx1, idx2] : [idx2, idx1];
    const keys = [];
    for (let i = a; i <= b; i++) {
      const flat = this.flatItems[i];
      if (flat.type === 'item') keys.push(flat._itemKey);
    }
    this._replaceSelection(keys);
  }

  _replaceSelection(keys) {
    this.selectedKeys = new Set(keys);
    if (keys.length > 0) this._lastRangeSelectedKey = keys[keys.length - 1];
    this._stateVersion++;
    this._emitSelectionChange();
    this._scheduleRender();
  }

  setSelectedKeys(keys, { emit = true } = {}) {
    if (this.options.selectionMode === 'none') return;
    const arr = Array.isArray(keys) ? keys : (keys instanceof Set ? [...keys] : []);
    const strArr = arr.map(k => this._toStrKey(k)).filter(k => k != null);
    if (this.options.selectionMode === 'single' && strArr.length > 1) {
      this.selectedKeys = new Set([strArr[strArr.length - 1]]);
    } else {
      this.selectedKeys = new Set(strArr);
    }
    if (this.selectedKeys.size > 0) {
      const last = [...this.selectedKeys].pop();
      this._lastRangeSelectedKey = last;
    }
    this._stateVersion++;
    if (emit) this._emitSelectionChange();
    this._scheduleRender();
  }

  setSelectedItem(itemKey) {
    if (this.options.selectionMode === 'none') return;
    const sk = this._toStrKey(itemKey);
    if (sk == null) return;
    this.selectedKeys = new Set([sk]);
    this._lastRangeSelectedKey = sk;
    this._stateVersion++;
    this._emitSelectionChange();
    this._scheduleRender();
  }

  toggleItemSelection(itemKey) {
    if (this.options.selectionMode === 'none') return;
    const sk = this._toStrKey(itemKey);
    if (sk == null) return;
    if (this.options.selectionMode === 'single') return this.setSelectedItem(itemKey);
    if (this.selectedKeys.has(sk)) this.selectedKeys.delete(sk);
    else {
      this.selectedKeys.add(sk);
      this._lastRangeSelectedKey = sk;
    }
    this._stateVersion++;
    this._emitSelectionChange();
    this._scheduleRender();
  }

  clearSelection() {
    if (this.selectedKeys.size === 0) return;
    this.selectedKeys.clear();
    this._stateVersion++;
    this._emitSelectionChange();
    this._scheduleRender();
  }

  selectAll() {
    if (this.options.selectionMode !== 'multiple') return;
    const keys = [];
    for (const flat of this.flatItems) {
      if (flat.type === 'item') keys.push(flat._itemKey);
    }
    this._replaceSelection(keys);
  }

  getSelection() {
    const items = [];
    const origKeys = [];
    for (const k of this.selectedKeys) {
      const full = `__item_${k}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        const flat = this.flatItems[idx];
        if (flat && flat.type === 'item') {
          items.push(flat.item);
          origKeys.push(flat._itemKeyOrig != null ? flat._itemKeyOrig : this._origKey(k));
        }
      }
    }
    return { keys: new Set(origKeys), items };
  }

  setFocusedItem(itemKey, { scrollIntoView = true, emit = true } = {}) {
    const sk = this._toStrKey(itemKey);
    if (sk != null) {
      let full = `__item_${sk}`;
      if (!this.keyToFlatIndex.has(full)) {
        const found = this._uncollapseGroupContainingItem(sk);
        if (!found) return false;
        full = `__item_${sk}`;
        if (!this.keyToFlatIndex.has(full)) return false;
      }
    }
    const before = this.focusedKey;
    this.focusedKey = sk;
    if (sk != null) this._lastRangeSelectedKey = sk;
    this._stateVersion++;
    if (emit && before !== sk && this.options.onFocusChange) {
      let item = null;
      if (sk != null) {
        const r = this.getFocusedItem();
        item = r.item;
      }
      const origK = this._origKey(sk);
      this.options.onFocusChange(origK, item);
    }
    if (scrollIntoView && sk != null) {
      const full = `__item_${sk}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) this._scrollItemIntoViewIfNeeded(idx);
    }
    this._scheduleRender();
    return true;
  }

  getFocusedItem() {
    if (this.focusedKey == null) return { key: null, item: null };
    const full = `__item_${this.focusedKey}`;
    const idx = this.keyToFlatIndex.get(full);
    if (idx != null) {
      const flat = this.flatItems[idx];
      if (flat && flat.type === 'item') {
        const orig = flat._itemKeyOrig != null ? flat._itemKeyOrig : this._origKey(this.focusedKey);
        return { key: orig, item: flat.item };
      }
    }
    return { key: this._origKey(this.focusedKey), item: null };
  }

  isItemSelected(itemKey) {
    const sk = this._toStrKey(itemKey);
    return sk != null && this.selectedKeys.has(sk);
  }

  isItemFocused(itemKey) {
    const sk = this._toStrKey(itemKey);
    return sk != null && this.focusedKey === sk;
  }

  _setFocusedItem(itemKey, { updateAnchor = true } = {}) {
    const before = this.focusedKey;
    const sk = this._toStrKey(itemKey);
    this.focusedKey = sk;
    if (updateAnchor && sk != null) this._lastRangeSelectedKey = sk;
    this._stateVersion++;
    if (before !== sk && this.options.onFocusChange) {
      let item = null;
      if (sk != null) {
        const full = `__item_${sk}`;
        const idx = this.keyToFlatIndex.get(full);
        if (idx != null) {
          const flat = this.flatItems[idx];
          if (flat && flat.type === 'item') item = flat.item;
        }
      }
      const origK = this._origKey(sk);
      this.options.onFocusChange(origK, item);
    }
  }

  _emitSelectionChange() {
    if (!this.options.onSelectionChange) return;
    const items = [];
    const origKeys = [];
    for (const k of this.selectedKeys) {
      const full = `__item_${k}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        const flat = this.flatItems[idx];
        if (flat && flat.type === 'item') {
          items.push(flat.item);
          origKeys.push(flat._itemKeyOrig != null ? flat._itemKeyOrig : this._origKey(k));
        }
      }
    }
    this.options.onSelectionChange(new Set(origKeys), items);
  }

  _uncollapseGroupContainingItem(strItemKey) {
    if (!this.isGrouped) return false;
    for (const g of this.data) {
      const gk = this._toStrKey(this.options.getGroupKey(g));
      if (this.collapsedGroups.has(gk)) {
        for (const it of g.items) {
          if (this._toStrKey(this.options.getItemKey(it)) === strItemKey) {
            this._expandGroupSilent(gk);
            return true;
          }
        }
      }
    }
    return false;
  }

  toggleGroupCollapse(groupKey) {
    const gk = this._toStrKey(groupKey);
    if (gk == null) return;
    this._captureAnchor();
    if (this.collapsedGroups.has(gk)) this.collapsedGroups.delete(gk);
    else this.collapsedGroups.add(gk);
    this.flatItems = this._flattenData(this.data);
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
    if (this.anchor) this._restoreAnchor();
    this._stateVersion++;
    this.visibleStartIndex = -1;
    this.visibleEndIndex = -1;
    if (this.options.onGroupCollapseChange) {
      this.options.onGroupCollapseChange(this._origKey(gk), this.collapsedGroups.has(gk));
    }
    if (this.options.onStickyGroupChange) {
      const sticky = this.currentStickyGroupKey != null ? this._buildStickyInfo(this.currentStickyGroupKey) : null;
      this.options.onStickyGroupChange(sticky);
    }
    this._scheduleRender();
  }

  setGroupCollapsed(groupKey, collapsed) {
    const gk = this._toStrKey(groupKey);
    const isCollapsed = this.collapsedGroups.has(gk);
    if (collapsed === isCollapsed) return;
    this.toggleGroupCollapse(groupKey);
  }

  expandOnlyGroup(groupKey) {
    const gk = this._toStrKey(groupKey);
    this._captureAnchor();
    this.collapsedGroups.clear();
    const changed = [];
    for (const g of this.data) {
      const k = this._toStrKey(this.options.getGroupKey(g));
      if (k !== gk) { this.collapsedGroups.add(k); changed.push(k); }
    }
    this._afterBatchCollapse(true, changed);
  }

  setExpandedGroups(groupKeys, { mode = 'replace', emitEach = true } = {}) {
    this._captureAnchor();
    const keys = (Array.isArray(groupKeys) ? groupKeys : (groupKeys instanceof Set ? [...groupKeys] : []))
      .map(k => this._toStrKey(k)).filter(k => k != null);
    if (mode === 'replace') {
      this.collapsedGroups.clear();
      for (const g of this.data) {
        const k = this._toStrKey(this.options.getGroupKey(g));
        if (!keys.includes(k)) this.collapsedGroups.add(k);
      }
    } else if (mode === 'add') {
      for (const k of keys) this.collapsedGroups.delete(k);
    } else if (mode === 'remove') {
      for (const k of keys) this.collapsedGroups.add(k);
    }
    this._afterBatchCollapse(emitEach, keys);
  }

  setCollapsedGroups(groupKeys, { mode = 'replace' } = {}) {
    const keys = (Array.isArray(groupKeys) ? groupKeys : (groupKeys instanceof Set ? [...groupKeys] : []))
      .map(k => this._toStrKey(k)).filter(k => k != null);
    this._captureAnchor();
    if (mode === 'replace') {
      this.collapsedGroups = new Set(keys);
    } else if (mode === 'add') {
      for (const k of keys) this.collapsedGroups.add(k);
    } else if (mode === 'remove') {
      for (const k of keys) this.collapsedGroups.delete(k);
    }
    this._afterBatchCollapse(true, keys);
  }

  isGroupCollapsed(groupKey) {
    const gk = this._toStrKey(groupKey);
    return gk != null && this.collapsedGroups.has(gk);
  }

  filterGroups(predicate) {
    if (!this.isGrouped) return;
    if (this._originalData == null) this._originalData = [...this.data];
    const filtered = this._originalData.filter(g => predicate(g));
    this.setData(filtered);
  }

  clearGroupFilter() {
    if (this._originalData == null) return;
    const backup = [...this._originalData];
    this._originalData = null;
    this.setData(backup);
  }

  _afterBatchCollapse(emitEach = true, changedKeys = []) {
    this.flatItems = this._flattenData(this.data);
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
    if (this.anchor) this._restoreAnchor();
    this._stateVersion++;
    this.visibleStartIndex = -1;
    this.visibleEndIndex = -1;
    if (emitEach && this.options.onGroupCollapseChange) {
      for (const k of changedKeys) this.options.onGroupCollapseChange(this._origKey(k), this.collapsedGroups.has(k));
    }
    if (this.options.onStickyGroupChange) {
      const sticky = this.currentStickyGroupKey != null ? this._buildStickyInfo(this.currentStickyGroupKey) : null;
      this.options.onStickyGroupChange(sticky);
    }
    this._scheduleRender();
  }

  _buildStickyInfo(groupKey) {
    const headerKey = `__header_${groupKey}`;
    const idx = this.keyToFlatIndex.get(headerKey);
    if (idx == null) return null;
    const flat = this.flatItems[idx];
    return {
      key: flat._groupKeyOrig != null ? flat._groupKeyOrig : this._origKey(groupKey),
      groupIndex: flat.groupIndex,
      group: flat.group,
      data: flat.data,
      collapsed: this.collapsedGroups.has(groupKey)
    };
  }

  _onScroll() {
    if (this._suppressScrollEvent) {
      this._suppressScrollEvent = false;
      return;
    }

    const newScrollTop = this.container.scrollTop;
    if (Math.abs(newScrollTop - this.scrollTop) < 0.5) return;

    this.scrollTop = newScrollTop;
    this._captureAnchor();
    this._scheduleUpdate(false);
  }

  _onContainerResize() {
    this._scheduleUpdate(false);
  }

  _scheduleUpdate(shouldRestoreAnchor) {
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._updateOffsets();
      if (shouldRestoreAnchor && this.anchor) this._restoreAnchor();
      this.scrollContent.style.height = `${this.totalHeight}px`;
      this._render();
      this._updateStickyHeader();
      this._checkLoadMore();
    });
  }

  _scheduleRender() {
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      if (this.offsets.length !== this.flatItems.length) {
        this._updateOffsets();
        this.scrollContent.style.height = `${this.totalHeight}px`;
      }
      this._render();
      this._updateStickyHeader();
      this._checkLoadMore();
    });
  }

  _captureAnchor() {
    if (this.flatItems.length === 0) {
      this.anchor = null;
      return;
    }
    const { start } = this._getVisibleRangeRaw();
    for (let i = start; i < this.flatItems.length; i++) {
      const flat = this.flatItems[i];
      const offset = this.offsets[i];
      if (offset >= this.scrollTop) {
        this.anchor = { key: flat._key, offset: this.scrollTop - offset };
        return;
      }
    }
    const last = this.flatItems[this.flatItems.length - 1];
    if (last) {
      const lastOffset = this.offsets[this.flatItems.length - 1];
      this.anchor = { key: last._key, offset: this.scrollTop - lastOffset };
    }
  }

  _restoreAnchor() {
    if (!this.anchor) return;
    const idx = this.keyToFlatIndex.get(this.anchor.key);
    if (idx == null) return;
    const newScrollTop = this.offsets[idx] + this.anchor.offset;
    this.container.scrollTop = newScrollTop;
    this.scrollTop = newScrollTop;
    this._suppressScrollEvent = true;
  }

  _flattenData(data) {
    const flat = [];
    this.keyToFlatIndex.clear();
    this.isGrouped = data.length > 0
      && (data[0].group !== undefined || data[0].groupKey !== undefined)
      && Array.isArray(data[0].items);

    if (this.isGrouped) {
      data.forEach((group, groupIndex) => {
        const groupKeyOrig = this.options.getGroupKey(group);
        const groupKey = this._registerKey(groupKeyOrig);
        const headerKey = `__header_${groupKey}`;
        flat.push({
          type: 'header', group: group.group, groupIndex,
          _groupKey: groupKey, _groupKeyOrig: groupKeyOrig, _key: headerKey, data: group
        });
        this.keyToFlatIndex.set(headerKey, flat.length - 1);

        if (!this.collapsedGroups.has(groupKey)) {
          group.items.forEach((item, itemIndex) => {
            const itemKeyOrig = this.options.getItemKey(item);
            const itemKey = this._registerKey(itemKeyOrig);
            const full = `__item_${itemKey}`;
            flat.push({
              type: 'item', item, groupIndex, itemIndex, group: group.group,
              _groupKey: groupKey, _itemKey: itemKey, _itemKeyOrig: itemKeyOrig, _key: full
            });
            this.keyToFlatIndex.set(full, flat.length - 1);
          });
        }
      });
    } else {
      data.forEach((item, index) => {
        const itemKeyOrig = this.options.getItemKey(item);
        const itemKey = this._registerKey(itemKeyOrig);
        const full = `__item_${itemKey}`;
        flat.push({
          type: 'item', item, index, _itemKey: itemKey, _itemKeyOrig: itemKeyOrig, _key: full
        });
        this.keyToFlatIndex.set(full, flat.length - 1);
      });
    }
    return flat;
  }

  _getHeightByKey(key, flatItem) {
    if (this.options.itemHeight !== null) {
      if (flatItem.type === 'header') return this.options.estimatedHeaderHeight;
      return this.options.itemHeight;
    }
    if (this.heightsByKey.has(key)) return this.heightsByKey.get(key);
    if (flatItem.type === 'header') return this.options.estimatedHeaderHeight;
    return this.options.estimatedItemHeight;
  }

  _updateOffsets() {
    const offsets = new Array(this.flatItems.length);
    let offset = 0;
    for (let i = 0; i < this.flatItems.length; i++) {
      const flat = this.flatItems[i];
      offsets[i] = offset;
      offset += this._getHeightByKey(flat._key, flat);
    }
    this.offsets = offsets;
    this.totalHeight = offset;
  }

  _getVisibleRangeRaw() {
    const viewportHeight = this.container.clientHeight;
    const scrollTop = this.scrollTop;
    const total = this.flatItems.length;
    if (total === 0) return { start: 0, end: 0 };
    let start = this._binarySearch(scrollTop);
    let end = this._binarySearch(scrollTop + viewportHeight);
    start = Math.max(0, start - this.options.buffer);
    end = Math.min(total, end + this.options.buffer);
    return { start, end };
  }

  _binarySearch(target) {
    let low = 0;
    let high = this.offsets.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.offsets[mid] === target) return mid;
      if (this.offsets[mid] < target) low = mid + 1;
      else high = mid - 1;
    }
    return low > 0 ? low - 1 : 0;
  }

  _render() {
    if (this.offsets.length !== this.flatItems.length) this._updateOffsets();
    const { start, end } = this._getVisibleRangeRaw();
    const viewportStart = start + this.options.buffer;
    const viewportEnd = end - this.options.buffer;
    const rangeChanged = start !== this.visibleStartIndex || end !== this.visibleEndIndex;
    const stateChanged = this._stateVersion !== this._lastRenderedStateVersion;

    if (rangeChanged && this.options.onVisibleRangeChange) {
      const s = Math.max(0, viewportStart);
      const e = Math.max(s, viewportEnd);
      const trueRange = this._computeTrueVisibleRange(s, e);
      this.options.onVisibleRangeChange(trueRange);
    }

    if (!rangeChanged && !stateChanged) return;
    this._lastRenderedStateVersion = this._stateVersion;
    this.visibleStartIndex = start;
    this.visibleEndIndex = end;

    if (this.resizeObserver) this.resizeObserver.disconnect();
    const fragment = document.createDocumentFragment();
    const observedElements = [];

    for (let i = start; i < end; i++) {
      const flatItem = this.flatItems[i];
      const itemEl = this._renderItem(flatItem, i);
      if (itemEl) {
        itemEl.style.position = 'absolute';
        itemEl.style.top = `${this.offsets[i]}px`;
        itemEl.style.left = '0';
        itemEl.style.width = '100%';
        itemEl.dataset.key = flatItem._key;
        itemEl.dataset.index = i;
        fragment.appendChild(itemEl);
        observedElements.push(itemEl);
        this._observeImages(itemEl);
      }
    }

    this.itemsContainer.innerHTML = '';
    this.itemsContainer.appendChild(fragment);
    if (this.resizeObserver) {
      observedElements.forEach(el => this.resizeObserver.observe(el));
    }
  }

  _computeTrueVisibleRange(viewportStart, viewportEnd) {
    const scrollTop = this.scrollTop;
    const stickyH = (this.isGrouped && this.stickyHeader.style.display !== 'none') ? this.stickyHeader.offsetHeight : 0;
    const effectiveTop = scrollTop + stickyH;
    const effectiveBottom = scrollTop + this.container.clientHeight;

    let trueStart = -1;
    const scanStart = Math.max(0, viewportStart - 1);
    for (let i = scanStart; i < this.flatItems.length; i++) {
      const flat = this.flatItems[i];
      const top = this.offsets[i];
      const bottom = top + this._getHeightByKey(flat._key, flat);
      if (bottom > effectiveTop) {
        trueStart = i;
        break;
      }
    }
    if (trueStart < 0) trueStart = Math.max(0, viewportStart);

    let trueEnd = this.flatItems.length - 1;
    for (let i = trueStart; i < this.flatItems.length; i++) {
      const flat = this.flatItems[i];
      const top = this.offsets[i];
      if (top >= effectiveBottom) {
        trueEnd = Math.max(trueStart, i - 1);
        break;
      }
    }

    const flatInView = this.flatItems.slice(trueStart, trueEnd + 1);
    return {
      startIndex: trueStart,
      endIndex: trueEnd,
      items: flatInView.filter(f => f.type === 'item').map(f => f.item),
      flatItems: flatInView
    };
  }

  _observeImages(rootEl) {
    if (this.options.itemHeight !== null) return;
    const images = rootEl.querySelectorAll('img');
    images.forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => {
          this._captureAnchor();
          this._scheduleUpdate(true);
        }, { once: true });
        img.addEventListener('error', () => {
          this._captureAnchor();
          this._scheduleUpdate(true);
        }, { once: true });
      }
    });
  }

  _renderItem(flatItem, index) {
    if (flatItem.type === 'header') {
      if (this.options.renderGroupHeader) {
        const origGk = flatItem._groupKeyOrig != null ? flatItem._groupKeyOrig : this._origKey(flatItem._groupKey);
        const ctx = {
          group: flatItem.group,
          groupIndex: flatItem.groupIndex,
          groupKey: origGk,
          data: flatItem.data,
          collapsed: this.collapsedGroups.has(flatItem._groupKey),
          toggleCollapse: () => this.toggleGroupCollapse(origGk)
        };
        const headerEl = this.options.renderGroupHeader(ctx, index);
        if (headerEl && headerEl instanceof HTMLElement) {
          headerEl.dataset.key = flatItem._key;
          headerEl.dataset.type = 'header';
          headerEl.dataset.groupKey = flatItem._groupKey;
          headerEl.style.cursor = 'pointer';
          headerEl.style.userSelect = 'none';
          return headerEl;
        }
      }
      return null;
    }

    if (this.options.renderItem) {
      const itemKey = flatItem._itemKey;
      const origItemKey = flatItem._itemKeyOrig != null ? flatItem._itemKeyOrig : this._origKey(itemKey);
      const origGk = flatItem._groupKey != null
        ? (flatItem._groupKeyOrig != null ? flatItem._groupKeyOrig : this._origKey(flatItem._groupKey))
        : null;
      const selected = this.selectedKeys.has(itemKey);
      const focused = this.focusedKey === itemKey;
      const itemCtx = this.isGrouped
        ? {
            item: flatItem.item, groupIndex: flatItem.groupIndex,
            itemIndex: flatItem.itemIndex, group: flatItem.group,
            groupKey: origGk, key: origItemKey,
            selected, focused
          }
        : {
            item: flatItem.item, index: flatItem.index, key: origItemKey,
            selected, focused
          };
      const itemEl = this.options.renderItem(itemCtx, index);
      if (itemEl && itemEl instanceof HTMLElement) {
        itemEl.dataset.key = flatItem._key;
        itemEl.dataset.type = 'item';
        itemEl.dataset.groupKey = flatItem._groupKey != null ? flatItem._groupKey : '';
        if (focused) itemEl.dataset.focused = 'true';
        if (selected) itemEl.dataset.selected = 'true';
        return itemEl;
      }
    }
    return null;
  }

  _updateStickyHeader() {
    const stickyRender = this.options.renderStickyHeader || this.options.renderGroupHeader;
    if (!this.isGrouped || !stickyRender) {
      if (this.currentStickyGroupKey !== null) {
        this.currentStickyGroupKey = null;
        if (this.options.onStickyGroupChange) this.options.onStickyGroupChange(null);
      }
      this.stickyHeader.style.display = 'none';
      return;
    }

    const scrollTop = this.scrollTop;
    let currentGroupKey = null;
    let currentGroupIndex = -1;
    let currentGroupData = null;
    let currentGroupOrigKey = null;
    let nextHeaderOffset = Infinity;

    for (let i = 0; i < this.flatItems.length; i++) {
      const flat = this.flatItems[i];
      if (flat.type === 'header') {
        const headerOffset = this.offsets[i];
        if (headerOffset <= scrollTop) {
          currentGroupKey = flat._groupKey;
          currentGroupIndex = flat.groupIndex;
          currentGroupData = flat.data;
          currentGroupOrigKey = flat._groupKeyOrig != null ? flat._groupKeyOrig : this._origKey(flat._groupKey);
        } else {
          nextHeaderOffset = headerOffset;
          break;
        }
      }
    }

    const changed = currentGroupKey !== this.currentStickyGroupKey;
    this.currentStickyGroupKey = currentGroupKey;

    if (currentGroupKey != null) {
      const ctx = {
        group: currentGroupData ? currentGroupData.group : null,
        groupIndex: currentGroupIndex,
        groupKey: currentGroupOrigKey,
        data: currentGroupData,
        collapsed: this.collapsedGroups.has(currentGroupKey),
        toggleCollapse: () => this.toggleGroupCollapse(currentGroupOrigKey)
      };
      const headerEl = stickyRender(ctx, -1);
      this.stickyHeader.innerHTML = '';
      if (headerEl && headerEl instanceof HTMLElement) {
        headerEl.style.pointerEvents = 'auto';
        headerEl.dataset.groupKey = currentGroupKey;
        this.stickyHeader.appendChild(headerEl);
      }
      this.stickyHeader.style.display = 'block';

      const nextHeaderDistance = nextHeaderOffset - scrollTop;
      const currentHeaderHeight = this.stickyHeader.offsetHeight;
      if (nextHeaderDistance < currentHeaderHeight && nextHeaderDistance > 0) {
        this.stickyHeader.style.transform = `translateY(${nextHeaderDistance - currentHeaderHeight}px)`;
      } else {
        this.stickyHeader.style.transform = 'translateY(0)';
      }
    } else {
      this.stickyHeader.style.display = 'none';
    }

    if (changed && this.options.onStickyGroupChange) {
      this.options.onStickyGroupChange(currentGroupKey != null ? {
        key: currentGroupOrigKey,
        groupIndex: currentGroupIndex,
        group: currentGroupData ? currentGroupData.group : null,
        data: currentGroupData,
        collapsed: this.collapsedGroups.has(currentGroupKey)
      } : null);
    }
  }

  async _checkLoadMore() {
    if (!this.options.onLoadMore || this.isLoading || !this.hasMore) return;
    const distanceToBottom = this.totalHeight - this.scrollTop - this.container.clientHeight;
    if (distanceToBottom <= this.options.threshold) {
      this.isLoading = true;
      try {
        const result = await this.options.onLoadMore();
        if (result === false) this.hasMore = false;
      } catch (e) {
        console.error('Load more error:', e);
      } finally {
        this.isLoading = false;
      }
    }
  }

  _mergeGroupsIntoData(existingData, newGroups) {
    const merged = [...existingData];
    const groupKeyToIndex = new Map();
    merged.forEach((g, i) => {
      const key = this._toStrKey(this.options.getGroupKey(g));
      if (key != null) groupKeyToIndex.set(key, i);
    });
    for (const newGroup of newGroups) {
      const key = this._toStrKey(this.options.getGroupKey(newGroup));
      if (key != null && groupKeyToIndex.has(key)) {
        const idx = groupKeyToIndex.get(key);
        merged[idx] = { ...merged[idx], items: [...merged[idx].items, ...newGroup.items] };
      } else {
        merged.push(newGroup);
        if (key != null) groupKeyToIndex.set(key, merged.length - 1);
      }
    }
    return merged;
  }

  setData(data) {
    this._captureAnchor();
    this.data = data || [];
    this.flatItems = this._flattenData(this.data);
    this.hasMore = true;
    this.isLoading = false;
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
    if (this.anchor) this._restoreAnchor();
    this._scheduleRender();
  }

  appendData(data) {
    if (!data || data.length === 0) return;
    this._captureAnchor();
    if (this.isGrouped) {
      this.data = this._mergeGroupsIntoData(this.data, data);
    } else {
      this.data = [...this.data, ...data];
    }
    const oldFlatKeys = new Set(this.flatItems.map(f => f._key));
    this.flatItems = this._flattenData(this.data);
    if (this.options.itemHeight !== null) {
      for (let i = 0; i < this.flatItems.length; i++) {
        const flat = this.flatItems[i];
        if (!oldFlatKeys.has(flat._key)) {
          const h = flat.type === 'header' ? this.options.estimatedHeaderHeight : this.options.itemHeight;
          this.heightsByKey.set(flat._key, h);
        }
      }
    }
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
    if (this.anchor) this._restoreAnchor();
    this._scheduleRender();
  }

  scrollToIndex(index, behavior = 'auto') {
    if (index < 0 || index >= this.flatItems.length) return;
    const offset = this.offsets[index];
    this._suppressScrollEvent = true;
    this.container.scrollTo({ top: offset, behavior });
    this.scrollTop = offset;
    this._scheduleUpdate(false);
  }

  scrollToItem(itemKey, options = {}) {
    const { behavior = 'auto', align = 'start' } = options;
    const sk = this._toStrKey(itemKey);
    let fullKey = `__item_${sk}`;
    let idx = this.keyToFlatIndex.get(fullKey);
    if (idx == null) {
      if (this.isGrouped) this._uncollapseGroupContainingItem(sk);
      fullKey = `__item_${sk}`;
      idx = this.keyToFlatIndex.get(fullKey);
      if (idx == null) return false;
    }

    let targetTop = this.offsets[idx];
    const itemH = this._getHeightByKey(fullKey, this.flatItems[idx]);
    if (align === 'center') {
      targetTop = targetTop - (this.container.clientHeight / 2) + (itemH / 2);
    } else if (align === 'end') {
      targetTop = targetTop + itemH - this.container.clientHeight;
    }
    targetTop = Math.max(0, targetTop);
    this._suppressScrollEvent = true;
    this.container.scrollTo({ top: targetTop, behavior });
    this.scrollTop = targetTop;
    this._scheduleUpdate(false);
    return true;
  }

  scrollToGroup(groupKey, options = {}) {
    const { behavior = 'auto' } = options;
    const gk = this._toStrKey(groupKey);
    const fullKey = `__header_${gk}`;
    let idx = this.keyToFlatIndex.get(fullKey);
    if (idx == null) return false;
    if (this.collapsedGroups.has(gk)) {
      this._expandGroupSilent(gk);
      const idx2 = this.keyToFlatIndex.get(fullKey);
      if (idx2 != null) idx = idx2; else return false;
    }
    const offset = this.offsets[idx];
    this._suppressScrollEvent = true;
    this.container.scrollTo({ top: offset, behavior });
    this.scrollTop = offset;
    this._scheduleUpdate(false);
    return true;
  }

  getVisibleRange() {
    if (this.flatItems.length === 0) {
      return { startIndex: 0, endIndex: 0, items: [], flatItems: [] };
    }
    const viewportHeight = this.container.clientHeight;
    const start = this._binarySearch(this.scrollTop);
    const end = this._binarySearch(this.scrollTop + viewportHeight);
    return this._computeTrueVisibleRange(start, end + 1);
  }

  getCurrentStickyGroup() {
    if (!this.isGrouped || this.currentStickyGroupKey == null) return null;
    return this._buildStickyInfo(this.currentStickyGroupKey);
  }

  refresh() {
    this._captureAnchor();
    this.heightsByKey.clear();
    this._scheduleUpdate(true);
  }

  destroy() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.container.removeEventListener('scroll', this._onScroll);
    this.container.removeEventListener('keydown', this._onKeyDown);
    if (this.containerResizeObserver) this.containerResizeObserver.disconnect();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.container.innerHTML = '';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VirtualList;
}
if (typeof window !== 'undefined') {
  window.VirtualList = VirtualList;
}
