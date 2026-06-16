class VirtualList {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      itemHeight: null,
      estimatedItemHeight: 50,
      buffer: 5,
      threshold: 200,
      renderItem: null,
      renderGroupHeader: null,
      renderStickyHeader: null,
      onLoadMore: null,
      ...options
    };

    this.data = [];
    this.flatItems = [];
    this.heights = new Map();
    this.offsets = [];
    this.scrollTop = 0;
    this.visibleStartIndex = 0;
    this.visibleEndIndex = 0;
    this.isGrouped = false;
    this.isLoading = false;
    this.hasMore = true;

    this._init();
  }

  _init() {
    this._setupDOM();
    this._setupResizeObserver();
    this._bindEvents();
    this._updateTotalHeight();
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
      let needsUpdate = false;
      for (const entry of entries) {
        const index = parseInt(entry.target.dataset.index);
        const height = entry.contentRect.height;
        if (!isNaN(index) && this.heights.get(index) !== height) {
          this.heights.set(index, height);
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        this._updateOffsets();
        this._render();
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
    const newScrollTop = this.container.scrollTop;
    if (Math.abs(newScrollTop - this.scrollTop) < 1) return;

    this.scrollTop = newScrollTop;
    this._render();
    this._updateStickyHeader();
    this._checkLoadMore();
  }

  _onContainerResize() {
    this._render();
  }

  _flattenData(data) {
    const flat = [];
    this.isGrouped = data.length > 0 && data[0].group !== undefined && Array.isArray(data[0].items);

    if (this.isGrouped) {
      data.forEach((group, groupIndex) => {
        flat.push({
          type: 'header',
          group: group.group,
          groupIndex,
          data: group
        });
        group.items.forEach((item, itemIndex) => {
          flat.push({
            type: 'item',
            item,
            groupIndex,
            itemIndex,
            group: group.group
          });
        });
      });
    } else {
      data.forEach((item, index) => {
        flat.push({
          type: 'item',
          item,
          index
        });
      });
    }

    return flat;
  }

  _getItemHeight(index) {
    if (this.options.itemHeight !== null) {
      return this.options.itemHeight;
    }
    return this.heights.get(index) || this.options.estimatedItemHeight;
  }

  _updateOffsets() {
    const offsets = new Array(this.flatItems.length);
    let offset = 0;
    for (let i = 0; i < this.flatItems.length; i++) {
      offsets[i] = offset;
      offset += this._getItemHeight(i);
    }
    this.offsets = offsets;
    this.totalHeight = offset;
  }

  _updateTotalHeight() {
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
  }

  _getVisibleRange() {
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
      const mid = Math.floor((low + high) / 2);
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
    const { start, end } = this._getVisibleRange();

    if (start === this.visibleStartIndex && end === this.visibleEndIndex) {
      return;
    }

    this.visibleStartIndex = start;
    this.visibleEndIndex = end;

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
        itemEl.dataset.index = i;
        fragment.appendChild(itemEl);
        observedElements.push(itemEl);
      }
    }

    this.itemsContainer.innerHTML = '';
    this.itemsContainer.appendChild(fragment);

    if (this.resizeObserver) {
      observedElements.forEach(el => this.resizeObserver.observe(el));
    }
  }

  _renderItem(flatItem, index) {
    if (flatItem.type === 'header') {
      if (this.options.renderGroupHeader) {
        const headerEl = this.options.renderGroupHeader(flatItem.group, flatItem.groupIndex);
        if (headerEl) {
          headerEl.dataset.index = index;
          headerEl.dataset.type = 'header';
          headerEl.dataset.groupIndex = flatItem.groupIndex;
          return headerEl;
        }
      }
      return null;
    } else {
      if (this.options.renderItem) {
        const itemData = this.isGrouped
          ? { item: flatItem.item, groupIndex: flatItem.groupIndex, itemIndex: flatItem.itemIndex, group: flatItem.group }
          : { item: flatItem.item, index: flatItem.index };
        const itemEl = this.options.renderItem(itemData, index);
        if (itemEl) {
          itemEl.dataset.index = index;
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
      this.stickyHeader.style.display = 'none';
      return;
    }

    const scrollTop = this.scrollTop;
    let currentGroupIndex = -1;
    let nextHeaderOffset = Infinity;

    for (let i = 0; i < this.flatItems.length; i++) {
      if (this.flatItems[i].type === 'header') {
        const headerOffset = this.offsets[i];

        if (headerOffset <= scrollTop) {
          currentGroupIndex = this.flatItems[i].groupIndex;
        } else {
          nextHeaderOffset = headerOffset;
          break;
        }
      }
    }

    if (currentGroupIndex >= 0) {
      const group = this.data[currentGroupIndex];
      const headerEl = stickyRender(group.group, currentGroupIndex);
      this.stickyHeader.innerHTML = '';
      if (headerEl) {
        if (headerEl instanceof HTMLElement) {
          headerEl.style.pointerEvents = 'auto';
          this.stickyHeader.appendChild(headerEl);
        }
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
    const scrollHeight = this.scrollContent.offsetHeight;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;

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

  setData(data) {
    this.data = data || [];
    this.heights.clear();
    this.flatItems = this._flattenData(this.data);
    this._updateTotalHeight();
    this._render();
    this._updateStickyHeader();
    this.hasMore = true;
    this.isLoading = false;
  }

  appendData(data) {
    if (!data || data.length === 0) return;

    if (this.isGrouped) {
      this.data = [...this.data, ...data];
    } else {
      this.data = [...this.data, ...data];
    }

    const oldLength = this.flatItems.length;
    this.flatItems = this._flattenData(this.data);

    if (this.options.itemHeight !== null) {
      const itemHeight = this.options.itemHeight;
      for (let i = oldLength; i < this.flatItems.length; i++) {
        this.heights.set(i, itemHeight);
      }
    }

    const oldTotalHeight = this.totalHeight;
    this._updateOffsets();

    const heightDiff = this.totalHeight - oldTotalHeight;
    this.scrollContent.style.height = `${this.totalHeight}px`;

    this._render();
    this._updateStickyHeader();
  }

  scrollToIndex(index, behavior = 'auto') {
    if (index < 0 || index >= this.flatItems.length) return;

    const offset = this.offsets[index];
    this.container.scrollTo({
      top: offset,
      behavior
    });
  }

  refresh() {
    this.heights.clear();
    this._updateOffsets();
    this.scrollContent.style.height = `${this.totalHeight}px`;
    this._render();
    this._updateStickyHeader();
  }

  destroy() {
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
