class VirtualList {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      itemHeight: null,
      estimatedItemHeight: 50,
      estimatedHeaderHeight: 40,
      buffer: 5,
      threshold: 200,
      renderItem: null,
      renderGroupHeader: null,
      renderStickyHeader: null,
      onLoadMore: null,
      onVisibleRangeChange: null,
      onStickyGroupChange: null,
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
      let changedKeys = [];
      for (const entry of entries) {
        const key = entry.target.dataset.key;
        const height = entry.contentRect.height;
        if (key && this.heightsByKey.get(key) !== height) {
          this.heightsByKey.set(key, height);
          changedKeys.push({ key, height });
        }
      }
      if (changedKeys.length > 0) {
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
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._updateOffsets();

      if (shouldRestoreAnchor && this.anchor && this.options.itemHeight === null) {
        this._restoreAnchor();
      }

      this.scrollContent.style.height = `${this.totalHeight}px`;
      this._render();
      this._updateStickyHeader();
      this._checkLoadMore();
    });
  }

  _scheduleRender() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
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
      const key = flat._key;
      const offset = this.offsets[i];
      if (offset >= this.scrollTop) {
        this.anchor = {
          key,
          offset: this.scrollTop - offset
        };
        return;
      }
    }
  }

  _restoreAnchor() {
    if (!this.anchor) return;
    const idx = this.keyToFlatIndex.get(this.anchor.key);
    if (idx == null) return;

    const newOffset = this.offsets[idx];
    const newScrollTop = newOffset + this.anchor.offset;
    this.container.scrollTop = newScrollTop;
    this.scrollTop = newScrollTop;
    this._suppressScrollEvent = true;
  }

  _getFlatKey(flatItem) {
    if (flatItem.type === 'header') {
      return `__header_${flatItem._groupKey}`;
    } else {
      return `__item_${flatItem._itemKey}`;
    }
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

        const headerFlat = {
          type: 'header',
          group: group.group,
          groupIndex,
          _groupKey: groupKey,
          _key: headerKey,
          data: group
        };
        flat.push(headerFlat);
        this.keyToFlatIndex.set(headerKey, flat.length - 1);

        group.items.forEach((item, itemIndex) => {
          const itemKey = this.options.getItemKey(item);
          const fullItemKey = `__item_${itemKey}`;
          const itemFlat = {
            type: 'item',
            item,
            groupIndex,
            itemIndex,
            group: group.group,
            _groupKey: groupKey,
            _itemKey: itemKey,
            _key: fullItemKey
          };
          flat.push(itemFlat);
          this.keyToFlatIndex.set(fullItemKey, flat.length - 1);
        });
      });
    } else {
      data.forEach((item, index) => {
        const itemKey = this.options.getItemKey(item);
        const fullItemKey = `__item_${itemKey}`;
        flat.push({
          type: 'item',
          item,
          index,
          _itemKey: itemKey,
          _key: fullItemKey
        });
        this.keyToFlatIndex.set(fullItemKey, flat.length - 1);
      });
    }

    return flat;
  }

  _getHeightByKey(key, flatItem) {
    if (this.options.itemHeight !== null) {
      if (flatItem.type === 'header') {
        return this.options.estimatedHeaderHeight;
      }
      return this.options.itemHeight;
    }
    if (this.heightsByKey.has(key)) {
      return this.heightsByKey.get(key);
    }
    if (flatItem.type === 'header') {
      return this.options.estimatedHeaderHeight;
    }
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

    if (total === 0) {
      return { start: 0, end: 0 };
    }

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
      if (this.offsets[mid] === target) {
        return mid;
      } else if (this.offsets[mid] < target) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
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
      const visibleFlat = this.flatItems.slice(viewportStart, viewportEnd);
      this.options.onVisibleRangeChange({
        startIndex: viewportStart,
        endIndex: viewportEnd,
        items: visibleFlat.map(f => f.type === 'item' ? f.item : null).filter(Boolean),
        flatItems: visibleFlat
      });
    }

    if (start === this.visibleStartIndex && end === this.visibleEndIndex) {
      return;
    }

    this.visibleStartIndex = start;
    this.visibleEndIndex = end;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

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

  _observeImages(rootEl) {
    if (this.options.itemHeight !== null) return;
    const images = rootEl.querySelectorAll('img');
    images.forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => {
          this._scheduleUpdate(true);
        }, { once: true });
        img.addEventListener('error', () => {
          this._scheduleUpdate(true);
        }, { once: true });
      }
    });
  }

  _renderItem(flatItem, index) {
    if (flatItem.type === 'header') {
      if (this.options.renderGroupHeader) {
        const headerEl = this.options.renderGroupHeader(flatItem.group, flatItem.groupIndex, flatItem.data);
        if (headerEl && headerEl instanceof HTMLElement) {
          headerEl.dataset.key = flatItem._key;
          headerEl.dataset.type = 'header';
          return headerEl;
        }
      }
      return null;
    } else {
      if (this.options.renderItem) {
        const itemData = this.isGrouped
          ? { item: flatItem.item, groupIndex: flatItem.groupIndex, itemIndex: flatItem.itemIndex, group: flatItem.group, groupKey: flatItem._groupKey, key: flatItem._itemKey }
          : { item: flatItem.item, index: flatItem.index, key: flatItem._itemKey };
        const itemEl = this.options.renderItem(itemData, index);
        if (itemEl && itemEl instanceof HTMLElement) {
          itemEl.dataset.key = flatItem._key;
          itemEl.dataset.type = 'item';
          return itemEl;
        }
      }
      return null;
    }
  }

  _updateStickyHeader() {
    const stickyRender = this.options.renderStickyHeader || this.options.renderGroupHeader;
    if (!this.isGrouped || !stickyRender) {
      if (this.currentStickyGroupKey !== null) {
        this.currentStickyGroupKey = null;
        if (this.options.onStickyGroupChange) {
          this.options.onStickyGroupChange(null);
        }
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
      const headerEl = stickyRender(currentGroupData ? currentGroupData.group : null, currentGroupIndex, currentGroupData);
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

    const scrollTop = this.scrollTop;
    const clientHeight = this.container.clientHeight;
    const distanceToBottom = this.totalHeight - scrollTop - clientHeight;

    if (distanceToBottom <= this.options.threshold) {
      this.isLoading = true;
      try {
        const result = await this.options.onLoadMore();
        if (result === false) {
          this.hasMore = false;
        }
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
        merged[idx] = {
          ...merged[idx],
          items: [...merged[idx].items, ...newGroup.items]
        };
      } else {
        merged.push(newGroup);
        if (key != null) {
          groupKeyToIndex.set(key, merged.length - 1);
        }
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
    if (this.anchor && this.options.itemHeight === null) {
      this._restoreAnchor();
    }
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
    if (this.anchor && this.options.itemHeight === null) {
      this._restoreAnchor();
    }
    this._scheduleRender();
  }

  scrollToIndex(index, behavior = 'auto') {
    if (index < 0 || index >= this.flatItems.length) return;

    const offset = this.offsets[index];
    this._suppressScrollEvent = true;
    this.container.scrollTo({
      top: offset,
      behavior
    });
    this.scrollTop = offset;
    this._scheduleUpdate(false);
  }

  scrollToItem(itemKey, options = {}) {
    const { behavior = 'auto', align = 'start' } = options;
    const fullKey = `__item_${itemKey}`;
    const idx = this.keyToFlatIndex.get(fullKey);
    if (idx == null) return false;

    let targetTop = this.offsets[idx];
    if (align === 'center') {
      targetTop = targetTop - (this.container.clientHeight / 2) + (this._getHeightByKey(fullKey, this.flatItems[idx]) / 2);
    } else if (align === 'end') {
      targetTop = targetTop + this._getHeightByKey(fullKey, this.flatItems[idx]) - this.container.clientHeight;
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

    const offset = this.offsets[idx];
    this._suppressScrollEvent = true;
    this.container.scrollTo({ top: offset, behavior });
    this.scrollTop = offset;
    this._scheduleUpdate(false);
    return true;
  }

  getVisibleRange() {
    const viewportHeight = this.container.clientHeight;
    const scrollTop = this.scrollTop;
    const total = this.flatItems.length;

    if (total === 0) {
      return { startIndex: 0, endIndex: 0, items: [], flatItems: [] };
    }

    let startIdx = this._binarySearch(scrollTop);
    let endIdx = this._binarySearch(scrollTop + viewportHeight);
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(total - 1, endIdx);

    const flatInView = this.flatItems.slice(startIdx, endIdx + 1);
    return {
      startIndex: startIdx,
      endIndex: endIdx,
      items: flatInView.filter(f => f.type === 'item').map(f => f.item),
      flatItems: flatInView
    };
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
      data: flat.data
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
    if (this.containerResizeObserver) {
      this.containerResizeObserver.disconnect();
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.container.innerHTML = '';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VirtualList;
}
if (typeof window !== 'undefined') {
  window.VirtualList = VirtualList;
}
