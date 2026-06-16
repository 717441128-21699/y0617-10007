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

    this.selectedKeys = new Set();
    this.focusedKey = null;
    this._lastRangeSelectedKey = null;
    this.collapsedGroups = new Set();

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
        if (flat && flat.type === 'header') {
          this.toggleGroupCollapse(flat._groupKey);
        }
      }
      return;
    }

    const itemKey = this._extractItemKeyFromFull(key);
    if (itemKey == null) return;

    if (this.options.selectionMode === 'none') {
      this._setFocusedItem(itemKey);
      return;
    }

    if (e.shiftKey && this.options.selectionMode === 'multiple' && this._lastRangeSelectedKey != null) {
      this._selectRange(this._lastRangeSelectedKey, itemKey);
    } else if (e.ctrlKey || e.metaKey) {
      this.toggleItemSelection(itemKey);
    } else if (this.options.selectionMode === 'single') {
      this.setSelectedItem(itemKey);
    } else {
      this.setSelectedItem(itemKey);
    }
    this._setFocusedItem(itemKey);
  }

  _extractItemKeyFromFull(fullKey) {
    if (typeof fullKey !== 'string') return null;
    if (fullKey.startsWith('__item_')) return fullKey.slice('__item_'.length);
    return null;
  }

  _onKeyDown(e) {
    const mode = this.options.selectionMode;
    if (mode === 'none' && !this.focusedKey) return;

    const key = e.key;
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== ' ' && key !== 'Enter') return;

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      const step = key === 'ArrowUp' ? -1 : 1;

      let startIdx = -1;
      if (this.focusedKey != null) {
        const full = `__item_${this.focusedKey}`;
        startIdx = this.keyToFlatIndex.get(full);
      }
      if (startIdx == null) startIdx = -1;

      let nextIdx = startIdx + step;
      while (nextIdx >= 0 && nextIdx < this.flatItems.length) {
        const flat = this.flatItems[nextIdx];
        if (flat.type === 'item') break;
        nextIdx += step;
      }
      if (nextIdx < 0 || nextIdx >= this.flatItems.length) return;

      const nextFlat = this.flatItems[nextIdx];
      const itemKey = nextFlat._itemKey;

      if (e.shiftKey && mode === 'multiple') {
        this._selectRange(this._lastRangeSelectedKey != null ? this._lastRangeSelectedKey : itemKey, itemKey);
      }

      this._setFocusedItem(itemKey);
      this._scrollItemIntoViewIfNeeded(nextIdx);
      return;
    }

    if ((key === ' ' || key === 'Enter') && this.focusedKey != null && mode !== 'none') {
      e.preventDefault();
      if (mode === 'single') {
        this.setSelectedItem(this.focusedKey);
      } else {
        this.toggleItemSelection(this.focusedKey);
      }
    }
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
    const fromFull = `__item_${fromKey}`;
    const toFull = `__item_${toKey}`;
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
    const beforeSize = this.selectedKeys.size;
    this.selectedKeys = new Set(keys);
    if (keys.length > 0) this._lastRangeSelectedKey = keys[keys.length - 1];
    if (beforeSize !== this.selectedKeys.size || keys.some(k => !this.selectedKeys.has(k))) {
      this._emitSelectionChange();
      this._scheduleRender();
    }
  }

  _setFocusedItem(itemKey) {
    if (this.focusedKey === itemKey) return;
    this.focusedKey = itemKey;
    this._lastRangeSelectedKey = itemKey;
    if (this.options.onFocusChange) {
      let item = null;
      const full = `__item_${itemKey}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        const flat = this.flatItems[idx];
        if (flat && flat.type === 'item') item = flat.item;
      }
      this.options.onFocusChange(itemKey, item);
    }
    this._scheduleRender();
  }

  _emitSelectionChange() {
    if (!this.options.onSelectionChange) return;
    const items = [];
    for (const k of this.selectedKeys) {
      const full = `__item_${k}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        const flat = this.flatItems[idx];
        if (flat && flat.type === 'item') items.push(flat.item);
      }
    }
    this.options.onSelectionChange(new Set(this.selectedKeys), items);
  }

  setSelectedItem(itemKey) {
    if (this.options.selectionMode === 'none') return;
    this.selectedKeys = new Set([itemKey]);
    this._lastRangeSelectedKey = itemKey;
    this._emitSelectionChange();
    this._scheduleRender();
  }

  toggleItemSelection(itemKey) {
    if (this.options.selectionMode === 'none') return;
    if (this.options.selectionMode === 'single') {
      return this.setSelectedItem(itemKey);
    }
    if (this.selectedKeys.has(itemKey)) {
      this.selectedKeys.delete(itemKey);
    } else {
      this.selectedKeys.add(itemKey);
      this._lastRangeSelectedKey = itemKey;
    }
    this._emitSelectionChange();
    this._scheduleRender();
  }

  clearSelection() {
    if (this.selectedKeys.size === 0) return;
    this.selectedKeys.clear();
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
    for (const k of this.selectedKeys) {
      const full = `__item_${k}`;
      const idx = this.keyToFlatIndex.get(full);
      if (idx != null) {
        const flat = this.flatItems[idx];
        if (flat && flat.type === 'item') items.push(flat.item);
      }
    }
    return { keys: new Set(this.selectedKeys), items };
  }

  getFocusedItem() {
    if (this.focusedKey == null) return { key: null, item: null };
    const full = `__item_${this.focusedKey}`;
    const idx = this.keyToFlatIndex.get(full);
    if (idx != null) {
      const flat = this.flatItems[idx];
      if (flat && flat.type === 'item') return { key: this.focusedKey, item: flat.item };
    }
    return { key: this.focusedKey, item: null };
  }

  isItemSelected(itemKey) {
    return this.selectedKeys.has(itemKey);
  }

  isItemFocused(itemKey) {
    return this.focusedKey === itemKey;
  }

  toggleGroupCollapse(groupKey) {
    this._captureAnchor();
    if (this.collapsedGroups.has(groupKey)) {
      this.collapsedGroups.delete(groupKey);
    } else {
      this.collapsedGroups.add(groupKey);
    }
    this.flatItems = this._flattenData(this.data);
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
    if (this.anchor) this._restoreAnchor();
    if (this.options.onGroupCollapseChange) {
      this.options.onGroupCollapseChange(groupKey, this.collapsedGroups.has(groupKey));
    }
    this._scheduleRender();
  }

  setGroupCollapsed(groupKey, collapsed) {
    const isCollapsed = this.collapsedGroups.has(groupKey);
    if (collapsed === isCollapsed) return;
    this.toggleGroupCollapse(groupKey);
  }

  isGroupCollapsed(groupKey) {
    return this.collapsedGroups.has(groupKey);
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
        const groupKey = this.options.getGroupKey(group);
        const headerKey = `__header_${groupKey}`;
        flat.push({
          type: 'header', group: group.group, groupIndex,
          _groupKey: groupKey, _key: headerKey, data: group
        });
        this.keyToFlatIndex.set(headerKey, flat.length - 1);

        if (!this.collapsedGroups.has(groupKey)) {
          group.items.forEach((item, itemIndex) => {
            const itemKey = this.options.getItemKey(item);
            const full = `__item_${itemKey}`;
            flat.push({
              type: 'item', item, groupIndex, itemIndex, group: group.group,
              _groupKey: groupKey, _itemKey: itemKey, _key: full
            });
            this.keyToFlatIndex.set(full, flat.length - 1);
          });
        }
      });
    } else {
      data.forEach((item, index) => {
        const itemKey = this.options.getItemKey(item);
        const full = `__item_${itemKey}`;
        flat.push({
          type: 'item', item, index, _itemKey: itemKey, _key: full
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
    if (this.offsets.length !== this.flatItems.length) {
      this._updateOffsets();
    }
    const { start, end } = this._getVisibleRangeRaw();
    const viewportStart = start + this.options.buffer;
    const viewportEnd = end - this.options.buffer;
    const rangeChanged = start !== this.visibleStartIndex || end !== this.visibleEndIndex;

    if (rangeChanged && this.options.onVisibleRangeChange) {
      const s = Math.max(0, viewportStart);
      const e = Math.max(s, viewportEnd);
      const { startIndex, endIndex, items, flatItems } = this._computeTrueVisibleRange(s, e);
      this.options.onVisibleRangeChange({ startIndex, endIndex, items, flatItems });
    }

    if (start === this.visibleStartIndex && end === this.visibleEndIndex) return;
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
    for (let i = Math.max(0, viewportStart - 1); i < this.flatItems.length; i++) {
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
        const ctx = {
          group: flatItem.group,
          groupIndex: flatItem.groupIndex,
          groupKey: flatItem._groupKey,
          data: flatItem.data,
          collapsed: this.collapsedGroups.has(flatItem._groupKey),
          toggleCollapse: () => this.toggleGroupCollapse(flatItem._groupKey)
        };
        const headerEl = this.options.renderGroupHeader(ctx, index);
        if (headerEl && headerEl instanceof HTMLElement) {
          headerEl.dataset.key = flatItem._key;
          headerEl.dataset.type = 'header';
          headerEl.style.cursor = 'pointer';
          headerEl.style.userSelect = 'none';
          return headerEl;
        }
      }
      return null;
    }

    if (this.options.renderItem) {
      const itemKey = flatItem._itemKey;
      const itemCtx = this.isGrouped
        ? {
            item: flatItem.item, groupIndex: flatItem.groupIndex,
            itemIndex: flatItem.itemIndex, group: flatItem.group,
            groupKey: flatItem._groupKey, key: itemKey,
            selected: this.selectedKeys.has(itemKey),
            focused: this.focusedKey === itemKey
          }
        : {
            item: flatItem.item, index: flatItem.index, key: itemKey,
            selected: this.selectedKeys.has(itemKey),
            focused: this.focusedKey === itemKey
          };
      const itemEl = this.options.renderItem(itemCtx, index);
      if (itemEl && itemEl instanceof HTMLElement) {
        itemEl.dataset.key = flatItem._key;
        itemEl.dataset.type = 'item';
        if (this.focusedKey === itemKey) itemEl.dataset.focused = 'true';
        if (this.selectedKeys.has(itemKey)) itemEl.dataset.selected = 'true';
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
    let nextHeaderOffset = Infinity;

    for (let i = 0; i < this.flatItems.length; i++) {
      const flat = this.flatItems[i];
      if (flat.type === 'header') {
        const headerOffset = this.offsets[i];
        if (headerOffset <= scrollTop) {
          currentGroupKey = flat._groupKey;
          currentGroupIndex = flat.groupIndex;
          currentGroupData = flat.data;
        } else {
          nextHeaderOffset = headerOffset;
          break;
        }
      }
    }

    if (currentGroupKey !== this.currentStickyGroupKey && this.options.onStickyGroupChange) {
      this.options.onStickyGroupChange(currentGroupKey != null ? {
        key: currentGroupKey,
        groupIndex: currentGroupIndex,
        group: currentGroupData ? currentGroupData.group : null,
        data: currentGroupData
      } : null);
    }
    this.currentStickyGroupKey = currentGroupKey;

    if (currentGroupKey != null) {
      const ctx = {
        group: currentGroupData ? currentGroupData.group : null,
        groupIndex: currentGroupIndex,
        groupKey: currentGroupKey,
        data: currentGroupData,
        collapsed: this.collapsedGroups.has(currentGroupKey),
        toggleCollapse: () => this.toggleGroupCollapse(currentGroupKey)
      };
      const headerEl = stickyRender(ctx, -1);
      this.stickyHeader.innerHTML = '';
      if (headerEl && headerEl instanceof HTMLElement) {
        headerEl.style.pointerEvents = 'auto';
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
      const key = this.options.getGroupKey(g);
      if (key != null) groupKeyToIndex.set(key, i);
    });
    for (const newGroup of newGroups) {
      const key = this.options.getGroupKey(newGroup);
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
    const fullKey = `__item_${itemKey}`;
    const idx = this.keyToFlatIndex.get(fullKey);
    if (idx == null) return false;

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
    const fullKey = `__header_${groupKey}`;
    const idx = this.keyToFlatIndex.get(fullKey);
    if (idx == null) return false;
    if (this.collapsedGroups.has(groupKey)) {
      this.setGroupCollapsed(groupKey, false);
      const newIdx = this.keyToFlatIndex.get(fullKey);
      if (newIdx == null) return false;
      const offset = this.offsets[newIdx];
      this._suppressScrollEvent = true;
      this.container.scrollTo({ top: offset, behavior });
      this.scrollTop = offset;
      this._scheduleUpdate(false);
      return true;
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
    const headerKey = `__header_${this.currentStickyGroupKey}`;
    const idx = this.keyToFlatIndex.get(headerKey);
    if (idx == null) return null;
    const flat = this.flatItems[idx];
    return {
      key: this.currentStickyGroupKey,
      groupIndex: flat.groupIndex,
      group: flat.group,
      data: flat.data,
      collapsed: this.collapsedGroups.has(this.currentStickyGroupKey)
    };
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
