// ============================================
// ari - Habit Tracker
// "We are what we repeatedly do."
// ============================================

// ============================================
// IndexedDB Database
// ============================================

class AriDatabase {
  constructor() {
    this.dbName = 'AriDB';
    this.dbVersion = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(this.db); };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('habits')) {
          const hs = db.createObjectStore('habits', { keyPath: 'id' });
          hs.createIndex('status', 'status');
          hs.createIndex('sort_order', 'sort_order');
        }
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath: ['habit_id', 'date'] });
          ls.createIndex('habit_id', 'habit_id');
          ls.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'date' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
    });
  }

  _tx(store, mode, op) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([store], mode);
      const s = tx.objectStore(store);
      const req = op(s);
      if (req instanceof IDBRequest) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
      else { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }
    });
  }

  async createHabit(h) { return this._tx('habits', 'readwrite', s => s.add(h)); }
  async updateHabit(h) { return this._tx('habits', 'readwrite', s => s.put(h)); }
  async deleteHabit(id) { return this._tx('habits', 'readwrite', s => s.delete(id)); }
  async getHabits(includeArchived = false) {
    const habits = await this._tx('habits', 'readonly', s => s.getAll());
    return (includeArchived ? habits : habits.filter(h => h.status !== 'archived')).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  async setLog(log) { return this._tx('logs', 'readwrite', s => s.put(log)); }
  async getLogs() { return this._tx('logs', 'readonly', s => s.getAll()); }
  async deleteLogsForHabit(habitId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['logs'], 'readwrite');
      const idx = tx.objectStore('logs').index('habit_id');
      const req = idx.openCursor(IDBKeyRange.only(habitId));
      req.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async setNote(n) { return this._tx('notes', 'readwrite', s => s.put(n)); }
  async getNotes() { return this._tx('notes', 'readonly', s => s.getAll()); }
  async deleteNote(date) { return this._tx('notes', 'readwrite', s => s.delete(date)); }
  async getSetting(key) { const r = await this._tx('settings', 'readonly', s => s.get(key)); return r?.value; }
  async setSetting(key, value) { return this._tx('settings', 'readwrite', s => s.put({ key, value })); }
  async clearAll() {
    await this._tx('habits', 'readwrite', s => s.clear());
    await this._tx('logs', 'readwrite', s => s.clear());
    await this._tx('notes', 'readwrite', s => s.clear());
  }
}

const db = new AriDatabase();

// ============================================
// Colors
// ============================================

const COLORS = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6'];
const ACCENT_COLORS = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#22c55e','#3b82f6'];

// ============================================
// App
// ============================================

class AriApp {
  constructor() {
    this.habits = [];
    this.logs = new Map();
    this.notes = new Map();
    this.settings = { theme: 'system', accent: '#6366f1', daysToShow: 365, cellSize: 'medium' };
    this.currentView = 'grid';
    this.editingHabitId = null;
    
    // Canvas transform state
    this.viewportX = 0;
    this.viewportY = 0;
    this.scale = 1;
    this.minScale = 0.2;
    this.maxScale = 3;
    
    // Panning state
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panStartViewportX = 0;
    this.panStartViewportY = 0;
    
    // Grid dimension presets
    this.cellSizePresets = {
      small:  { cellSize: 12, cellGap: 2, labelWidth: 120 },
      medium: { cellSize: 16, cellGap: 3, labelWidth: 140 },
      large:  { cellSize: 22, cellGap: 4, labelWidth: 160 }
    };
    
    // Grid dimensions (set from preset)
    this.cellSize = 16;
    this.cellGap = 3;
    this.labelWidth = 140;
    this.headerHeight = 32;
    this.padding = 40;
    
    // Cached grid info
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.todayColumnX = 0;
    
    // Today view
    this.viewingDate = null;
    this.sidebarOpen = true;
  }

  async init() {
    await db.init();
    await this.loadSettings();
    await this.loadHabits();
    await this.loadAllLogs();
    await this.loadNotes();
    this.setupEventListeners();
    this.setupColorPickers();
    this.setupCanvas();
    this.applyTheme();
    this.render();
    this.setDefaultDate();
    requestAnimationFrame(() => this.resetView());
  }

  async loadSettings() {
    const theme = await db.getSetting('theme');
    const accent = await db.getSetting('accent');
    const days = await db.getSetting('daysToShow');
    const cellSize = await db.getSetting('cellSize');
    if (theme) this.settings.theme = theme;
    if (accent) this.settings.accent = accent;
    if (days) this.settings.daysToShow = parseInt(days);
    if (cellSize) this.settings.cellSize = cellSize;
    
    // Apply cell size preset
    this.applyCellSizePreset(this.settings.cellSize);
    
    document.getElementById('settingTheme').value = this.settings.theme;
    document.getElementById('settingDays').value = this.settings.daysToShow;
    document.getElementById('settingCellSize').value = this.settings.cellSize;
  }
  
  applyCellSizePreset(size) {
    const preset = this.cellSizePresets[size] || this.cellSizePresets.medium;
    this.cellSize = preset.cellSize;
    this.cellGap = preset.cellGap;
    this.labelWidth = preset.labelWidth;
  }
  
  async setCellSize(size) {
    this.settings.cellSize = size;
    await db.setSetting('cellSize', size);
    this.applyCellSizePreset(size);
    this.renderGrid();
    requestAnimationFrame(() => this.resetView());
  }

  async loadHabits() { this.habits = await db.getHabits(false); }

  async loadAllLogs() {
    const logs = await db.getLogs();
    this.logs = new Map();
    for (const log of logs) {
      if (!this.logs.has(log.habit_id)) this.logs.set(log.habit_id, new Map());
      this.logs.get(log.habit_id).set(log.date, log);
    }
  }

  async loadNotes() {
    const notes = await db.getNotes();
    this.notes = new Map();
    for (const note of notes) this.notes.set(note.date, note.note);
  }

  // ============================================
  // Canvas Setup
  // ============================================

  setupCanvas() {
    const container = document.getElementById('canvasContainer');
    
    // Mouse wheel = zoom
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * zoomFactor));
      
      if (newScale !== this.scale) {
        const worldX = (mouseX - this.viewportX) / this.scale;
        const worldY = (mouseY - this.viewportY) / this.scale;
        this.scale = newScale;
        this.viewportX = mouseX - worldX * this.scale;
        this.viewportY = mouseY - worldY * this.scale;
        this.applyTransform();
        this.updateZoomDisplay();
      }
    }, { passive: false });

    // Mouse down = start pan
    container.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
        this.panStartViewportX = this.viewportX;
        this.panStartViewportY = this.viewportY;
        container.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        this.viewportX = this.panStartViewportX + (e.clientX - this.panStartX);
        this.viewportY = this.panStartViewportY + (e.clientY - this.panStartY);
        this.applyTransform();
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        document.getElementById('canvasContainer').style.cursor = 'grab';
      }
    });

    // Touch support
    let lastTouchDist = 0;
    let lastTouchCenter = { x: 0, y: 0 };

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isPanning = true;
        this.panStartX = e.touches[0].clientX;
        this.panStartY = e.touches[0].clientY;
        this.panStartViewportX = this.viewportX;
        this.panStartViewportY = this.viewportY;
      } else if (e.touches.length === 2) {
        this.isPanning = false;
        lastTouchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        lastTouchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
      }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && this.isPanning) {
        this.viewportX = this.panStartViewportX + (e.touches[0].clientX - this.panStartX);
        this.viewportY = this.panStartViewportY + (e.touches[0].clientY - this.panStartY);
        this.applyTransform();
      } else if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const center = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
        const rect = container.getBoundingClientRect();
        const localX = center.x - rect.left;
        const localY = center.y - rect.top;
        const zoomFactor = dist / lastTouchDist;
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * zoomFactor));
        
        if (newScale !== this.scale) {
          const worldX = (localX - this.viewportX) / this.scale;
          const worldY = (localY - this.viewportY) / this.scale;
          this.scale = newScale;
          this.viewportX = localX - worldX * this.scale;
          this.viewportY = localY - worldY * this.scale;
        }
        this.viewportX += center.x - lastTouchCenter.x;
        this.viewportY += center.y - lastTouchCenter.y;
        lastTouchDist = dist;
        lastTouchCenter = center;
        this.applyTransform();
        this.updateZoomDisplay();
      }
    }, { passive: true });

    container.addEventListener('touchend', () => { this.isPanning = false; });
  }

  applyTransform() {
    const world = document.getElementById('canvasWorld');
    world.style.transform = `translate(${this.viewportX}px, ${this.viewportY}px) scale(${this.scale})`;
  }

  resetView() {
    const container = document.getElementById('canvasContainer');
    if (!container || this.gridWidth === 0) return;
    
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    
    // Scale to fit height nicely
    this.scale = Math.min(ch * 0.75 / this.gridHeight, 1.2);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale));
    
    // Center on today
    this.viewportX = (cw / 2) - (this.todayColumnX * this.scale);
    this.viewportY = (ch - this.gridHeight * this.scale) / 2;
    
    this.applyTransform();
    this.updateZoomDisplay();
  }

  zoomIn() {
    const container = document.getElementById('canvasContainer');
    const rect = container.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const newScale = Math.min(this.maxScale, this.scale * 1.25);
    const worldX = (centerX - this.viewportX) / this.scale;
    const worldY = (centerY - this.viewportY) / this.scale;
    this.scale = newScale;
    this.viewportX = centerX - worldX * this.scale;
    this.viewportY = centerY - worldY * this.scale;
    
    this.applyTransform();
    this.updateZoomDisplay();
  }

  zoomOut() {
    const container = document.getElementById('canvasContainer');
    const rect = container.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const newScale = Math.max(this.minScale, this.scale / 1.25);
    const worldX = (centerX - this.viewportX) / this.scale;
    const worldY = (centerY - this.viewportY) / this.scale;
    this.scale = newScale;
    this.viewportX = centerX - worldX * this.scale;
    this.viewportY = centerY - worldY * this.scale;
    
    this.applyTransform();
    this.updateZoomDisplay();
  }

  updateZoomDisplay() {
    document.getElementById('zoomLevel').textContent = `${Math.round(this.scale * 100)}%`;
  }

  // ============================================
  // Event Listeners
  // ============================================

  setupEventListeners() {
    document.querySelectorAll('.modal-overlay').forEach(o => {
      o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('active'); });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); this.openNewHabitModal(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); this.toggleSidebar(); }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); this.resetView(); }
      
      const active = document.activeElement;
      if (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA' && !e.metaKey && !e.ctrlKey) {
        if (e.key === '1') this.setView('grid');
        if (e.key === '2') this.setView('today');
        if (e.key === '3') this.setView('stats');
      }
    });

    document.getElementById('newHabitFrequency').addEventListener('change', (e) => {
      document.getElementById('newHabitTargetGroup').style.display = e.target.value === 'weekly' ? 'block' : 'none';
    });
    document.getElementById('editHabitFrequency').addEventListener('change', (e) => {
      document.getElementById('editHabitTargetGroup').style.display = e.target.value === 'weekly' ? 'block' : 'none';
    });

    let noteTimeout;
    document.getElementById('todayNote').addEventListener('input', (e) => {
      clearTimeout(noteTimeout);
      noteTimeout = setTimeout(() => this.saveViewingDateNote(e.target.value), 500);
    });

    document.getElementById('sidebarToggle').addEventListener('click', () => this.toggleSidebar());
    
    window.addEventListener('resize', () => {
      if (this.currentView === 'grid') this.resetView();
    });
  }

  setupColorPickers() {
    document.getElementById('newHabitColors').innerHTML = COLORS.map((c, i) =>
      `<div class="color-swatch ${i === 0 ? 'selected' : ''}" data-color="${c}" style="background:${c}" onclick="app.selectColor('newHabitColors','${c}')"></div>`
    ).join('');
    document.getElementById('editHabitColors').innerHTML = COLORS.map(c =>
      `<div class="color-swatch" data-color="${c}" style="background:${c}" onclick="app.selectColor('editHabitColors','${c}')"></div>`
    ).join('');
    document.getElementById('accentColors').innerHTML = ACCENT_COLORS.map(c =>
      `<div class="color-swatch ${c === this.settings.accent ? 'selected' : ''}" data-color="${c}" style="background:${c}" onclick="app.setAccentColor('${c}')"></div>`
    ).join('');
  }

  selectColor(pickerId, color) {
    document.getElementById(pickerId).querySelectorAll('.color-swatch').forEach(s => 
      s.classList.toggle('selected', s.dataset.color === color)
    );
  }

  toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;

    document
      .getElementById('sidebar')
      .classList.toggle('collapsed', !this.sidebarOpen);
  }


  // ============================================
  // Views
  // ============================================

  setView(view) {
    this.currentView = view;
    if (view === 'today') this.viewingDate = null;
    
    document.querySelectorAll('.nav-item[data-view]').forEach(i => 
      i.classList.toggle('active', i.dataset.view === view)
    );
    document.querySelectorAll('.view').forEach(v => 
      v.classList.toggle('active', v.id === `view${view.charAt(0).toUpperCase() + view.slice(1)}`)
    );
    
    if (view === 'today') this.renderTodayView();
    else if (view === 'stats') this.renderStatsView();
    else if (view === 'grid') {
      this.renderGrid();
      requestAnimationFrame(() => this.resetView());
    }
  }

  render() {
    this.renderHabitList();
    this.renderGrid();
    if (this.currentView === 'today') this.renderTodayView();
    else if (this.currentView === 'stats') this.renderStatsView();
  }

  renderHabitList() {
    const list = document.getElementById('habitList');
    if (this.habits.length === 0) {
      list.innerHTML = '<div class="habit-item empty">No habits yet</div>';
      return;
    }
    list.innerHTML = this.habits.map(h => `
      <div class="habit-item ${h.status === 'paused' ? 'paused' : ''}" onclick="app.openEditHabitModal('${h.id}')">
        <div class="habit-dot" style="background:${h.color}"></div>
        <span class="habit-item-name">${this.escapeHtml(h.name)}</span>
      </div>
    `).join('');
  }

  renderGrid() {
    const svg = document.getElementById('habitGrid');
    const container = document.getElementById('canvasContainer');
    const empty = document.getElementById('gridEmpty');
    
    if (this.habits.length === 0) {
      container.style.display = 'none';
      empty.classList.add('active');
      return;
    }
    container.style.display = '';
    empty.classList.remove('active');
    
    const activeHabits = this.habits.filter(h => h.status !== 'paused');
    if (activeHabits.length === 0) { 
      svg.innerHTML = ''; 
      this.gridWidth = 0;
      this.gridHeight = 0;
      return; 
    }

    const { cellSize, cellGap, labelWidth, headerHeight, padding } = this;
    const today = new Date(); 
    today.setHours(0, 0, 0, 0);
    const todayStr = this.formatDate(today);
    
    // Timeline: 80% past, 20% future, centered on today
    const daysToShow = this.settings.daysToShow;
    const daysInPast = Math.floor(daysToShow * 0.8);
    const daysInFuture = daysToShow - daysInPast - 1;
    
    const dates = [];
    for (let i = -daysInPast; i <= daysInFuture; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      dates.push(this.formatDate(d));
    }
    const todayIndex = daysInPast;

    // Grid dimensions
    const rowH = cellSize + cellGap;
    this.gridWidth = labelWidth + dates.length * (cellSize + cellGap) + padding * 2;
    this.gridHeight = headerHeight + activeHabits.length * rowH + padding * 2;
    this.todayColumnX = padding + labelWidth + todayIndex * (cellSize + cellGap) + cellSize / 2;

    svg.setAttribute('width', this.gridWidth);
    svg.setAttribute('height', this.gridHeight);

    let content = '';
    const ox = padding, oy = padding;

    // Month labels
    let lastMonth = '';
    dates.forEach((date, i) => {
      const [y, m, d] = date.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const mk = `${y}-${m}`;
      if (mk !== lastMonth && (d <= 7 || i === 0)) {
        const x = ox + labelWidth + i * (cellSize + cellGap);
        content += `<text class="grid-month" x="${x}" y="${oy + 12}">${dt.toLocaleDateString('en-US', { month: 'short' })}</text>`;
        lastMonth = mk;
      }
    });

    // Habits
    activeHabits.forEach((habit, hi) => {
      const y = oy + headerHeight + hi * rowH;
      const logs = this.logs.get(habit.id) || new Map();
      content += `<text class="grid-label" x="${ox}" y="${y + cellSize - 2}">${this.escapeHtml(this.truncate(habit.name, 16))}</text>`;
      
      dates.forEach((date, di) => {
        const x = ox + labelWidth + di * (cellSize + cellGap);
        const completed = logs.get(date)?.completed || false;
        const isFuture = date > todayStr;
        const isToday = date === todayStr;
        
        let style = 'fill:var(--cell-empty);';
        let cls = 'grid-cell';
        if (isFuture) cls += ' future';
        else if (completed) { style = `fill:${habit.color};`; cls += ' filled'; }
        
        // Scale corner radius with cell size
        const cornerRadius = Math.max(2, Math.round(cellSize * 0.15));
        const ringRadius = cornerRadius + 1;
        
        if (isToday) content += `<rect class="today-ring" x="${x - 2}" y="${y - 2}" width="${cellSize + 4}" height="${cellSize + 4}" rx="${ringRadius}"/>`;
        
        const click = isFuture ? '' : `onclick="app.toggleLog('${habit.id}','${date}')"`;
        content += `<rect class="${cls}" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="${cornerRadius}" style="${style}"
          ${click}
          onmouseenter="app.showTooltip(event,'${this.escapeHtml(habit.name)}','${date}',${completed},${isFuture})"
          onmouseleave="app.hideTooltip()"/>`;
      });
    });

    svg.innerHTML = content;
    
    if (dates.length > 0) {
      const s = this.parseDate(dates[0]), e = this.parseDate(dates[dates.length - 1]);
      document.getElementById('dateRangeDisplay').textContent = 
        `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
  }

  renderTodayView() {
    const viewDate = this.viewingDate ? this.parseDate(this.viewingDate) : new Date();
    const viewDateStr = this.formatDate(viewDate);
    const todayStr = this.formatDate(new Date());
    const isToday = viewDateStr === todayStr;
    const isFuture = viewDateStr > todayStr;

    document.getElementById('todayTitle').innerHTML = `
      <button class="icon-btn" onclick="app.navigateTodayView(-1)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
      <h1>${isToday ? 'Today' : viewDate.toLocaleDateString('en-US', { weekday: 'long' })}</h1>
      <button class="icon-btn" onclick="app.navigateTodayView(1)" ${isFuture || isToday ? 'disabled' : ''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
      ${!isToday ? '<button class="btn btn-secondary btn-sm" onclick="app.goToTodayView()" style="margin-left:12px">Today</button>' : ''}
    `;
    document.getElementById('todayDate').textContent = viewDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const activeHabits = this.habits.filter(h => h.status === 'active');
    let done = 0;
    activeHabits.forEach(h => { if (this.logs.get(h.id)?.get(viewDateStr)?.completed) done++; });
    const pct = activeHabits.length > 0 ? Math.round((done / activeHabits.length) * 100) : 0;

    document.getElementById('todayProgress').innerHTML = `
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-text"><strong>${done} of ${activeHabits.length}</strong> habits completed${isToday ? ' today' : ''}</div>
    `;

    document.getElementById('todayHabits').innerHTML = activeHabits.length === 0 
      ? '<p style="color:var(--text-tertiary);text-align:center;padding:20px">No active habits</p>'
      : activeHabits.map(h => {
          const completed = this.logs.get(h.id)?.get(viewDateStr)?.completed || false;
          const stats = this.getQuickStats(h.id);
          return `<div class="today-habit ${completed ? 'completed' : ''}" ${isFuture ? 'style="cursor:not-allowed;opacity:0.5"' : `onclick="app.toggleLog('${h.id}','${viewDateStr}')"`}>
            <div class="today-check" style="border-color:${h.color};${completed ? `background:${h.color}` : ''}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div class="today-habit-info">
              <div class="today-habit-name">${this.escapeHtml(h.name)}</div>
              <div class="today-habit-meta">${stats.streak} day streak · ${stats.rate}% this month</div>
            </div>
          </div>`;
        }).join('');

    const textarea = document.getElementById('todayNote');
    textarea.value = this.notes.get(viewDateStr) || '';
    textarea.disabled = isFuture;
    textarea.placeholder = isFuture ? "Cannot add notes for future dates" : "How was your day? Any reflections...";
  }

  navigateTodayView(dir) {
    const curr = this.viewingDate ? this.parseDate(this.viewingDate) : new Date();
    curr.setDate(curr.getDate() + dir);
    const newStr = this.formatDate(curr);
    if (newStr > this.formatDate(new Date())) return;
    this.viewingDate = newStr === this.formatDate(new Date()) ? null : newStr;
    this.renderTodayView();
  }

  goToTodayView() { this.viewingDate = null; this.renderTodayView(); }

  renderStatsView() {
    const grid = document.getElementById('statsGrid');
    if (this.habits.length === 0) { grid.innerHTML = '<p style="color:var(--text-tertiary)">No habits to show.</p>'; return; }
    grid.innerHTML = this.habits.map(h => {
      const s = this.getFullStats(h.id);
      return `<div class="stat-card">
        <div class="stat-card-header"><div class="stat-color" style="background:${h.color}"></div><div class="stat-name">${this.escapeHtml(h.name)}</div></div>
        <div class="stat-values">
          <div class="stat-item"><div class="stat-value">${s.currentStreak}</div><div class="stat-label">Current Streak</div></div>
          <div class="stat-item"><div class="stat-value">${s.total}</div><div class="stat-label">Total</div></div>
          <div class="stat-item"><div class="stat-value">${s.monthRate}%</div><div class="stat-label">This Month</div></div>
          <div class="stat-item"><div class="stat-value">${s.longestStreak}</div><div class="stat-label">Best Streak</div></div>
        </div>
      </div>`;
    }).join('');
  }

  // ============================================
  // Stats
  // ============================================

  getQuickStats(habitId) {
    const logs = this.logs.get(habitId) || new Map();
    const today = new Date();
    let streak = 0, check = new Date(today);
    while (logs.get(this.formatDate(check))?.completed) { streak++; check.setDate(check.getDate() - 1); }
    let monthDone = 0;
    for (let d = 1; d <= today.getDate(); d++) {
      if (logs.get(this.formatDate(new Date(today.getFullYear(), today.getMonth(), d)))?.completed) monthDone++;
    }
    return { streak, rate: today.getDate() > 0 ? Math.round((monthDone / today.getDate()) * 100) : 0 };
  }

  getFullStats(habitId) {
    const logs = this.logs.get(habitId) || new Map();
    const today = new Date();
    let total = 0; logs.forEach(l => { if (l.completed) total++; });
    let currentStreak = 0, check = new Date(today);
    while (logs.get(this.formatDate(check))?.completed) { currentStreak++; check.setDate(check.getDate() - 1); }
    let longestStreak = 0, temp = 0, prev = null;
    Array.from(logs.keys()).sort().forEach(date => {
      if (logs.get(date)?.completed) {
        if (prev) { const diff = Math.round((this.parseDate(date) - this.parseDate(prev)) / 86400000); temp = diff === 1 ? temp + 1 : 1; }
        else temp = 1;
        longestStreak = Math.max(longestStreak, temp);
        prev = date;
      } else { temp = 0; prev = null; }
    });
    let monthDone = 0;
    for (let d = 1; d <= today.getDate(); d++) {
      if (logs.get(this.formatDate(new Date(today.getFullYear(), today.getMonth(), d)))?.completed) monthDone++;
    }
    return { total, currentStreak, longestStreak, monthRate: today.getDate() > 0 ? Math.round((monthDone / today.getDate()) * 100) : 0 };
  }

  // ============================================
  // Habit CRUD
  // ============================================

  openNewHabitModal() {
    document.getElementById('newHabitName').value = '';
    document.getElementById('newHabitDescription').value = '';
    document.getElementById('newHabitFrequency').value = 'daily';
    document.getElementById('newHabitTargetGroup').style.display = 'none';
    this.setDefaultDate();
    this.selectColor('newHabitColors', COLORS[0]);
    document.getElementById('newHabitModal').classList.add('active');
    setTimeout(() => document.getElementById('newHabitName').focus(), 100);
  }

  async createHabit() {
    const name = document.getElementById('newHabitName').value.trim();
    if (!name) { document.getElementById('newHabitName').focus(); return; }
    const habit = {
      id: crypto.randomUUID(), name,
      description: document.getElementById('newHabitDescription').value.trim() || null,
      color: document.querySelector('#newHabitColors .color-swatch.selected')?.dataset.color || COLORS[0],
      icon: null,
      frequency: document.getElementById('newHabitFrequency').value,
      target_days: document.getElementById('newHabitFrequency').value === 'weekly' ? parseInt(document.getElementById('newHabitTarget').value) : null,
      status: 'active',
      created_at: document.getElementById('newHabitStartDate').value || this.formatDate(new Date()),
      updated_at: new Date().toISOString(),
      archived_at: null,
      sort_order: this.habits.length
    };
    await db.createHabit(habit);
    this.habits.push(habit);
    this.logs.set(habit.id, new Map());
    this.closeModal('newHabitModal');
    this.render();
    requestAnimationFrame(() => this.resetView());
  }

  openEditHabitModal(habitId) {
    const habit = this.habits.find(h => h.id === habitId);
    if (!habit) return;
    this.editingHabitId = habitId;
    document.getElementById('editHabitName').value = habit.name;
    document.getElementById('editHabitDescription').value = habit.description || '';
    document.getElementById('editHabitFrequency').value = habit.frequency;
    document.getElementById('editHabitStatus').value = habit.status;
    document.getElementById('editHabitTargetGroup').style.display = habit.frequency === 'weekly' ? 'block' : 'none';
    document.getElementById('editHabitTarget').value = habit.target_days || 3;
    this.selectColor('editHabitColors', habit.color);
    document.getElementById('editHabitModal').classList.add('active');
  }

  async saveHabit() {
    if (!this.editingHabitId) return;
    const habit = this.habits.find(h => h.id === this.editingHabitId);
    if (!habit) return;
    const name = document.getElementById('editHabitName').value.trim();
    if (!name) { document.getElementById('editHabitName').focus(); return; }
    habit.name = name;
    habit.description = document.getElementById('editHabitDescription').value.trim() || null;
    habit.color = document.querySelector('#editHabitColors .color-swatch.selected')?.dataset.color || habit.color;
    habit.frequency = document.getElementById('editHabitFrequency').value;
    habit.target_days = habit.frequency === 'weekly' ? parseInt(document.getElementById('editHabitTarget').value) : null;
    habit.status = document.getElementById('editHabitStatus').value;
    habit.updated_at = new Date().toISOString();
    await db.updateHabit(habit);
    this.closeModal('editHabitModal');
    this.render();
  }

  async archiveHabit() {
    if (!this.editingHabitId) return;
    this.showConfirm('Archive Habit', 'Archive this habit? It will be hidden but data preserved.', async () => {
      const habit = this.habits.find(h => h.id === this.editingHabitId);
      if (habit) { habit.status = 'archived'; habit.archived_at = new Date().toISOString(); await db.updateHabit(habit); }
      this.habits = this.habits.filter(h => h.id !== this.editingHabitId);
      this.closeModal('editHabitModal');
      this.render();
    });
  }

  async deleteHabit() {
    if (!this.editingHabitId) return;
    this.showConfirm('Delete Habit', 'Permanently delete this habit and all data? This cannot be undone.', async () => {
      await db.deleteLogsForHabit(this.editingHabitId);
      await db.deleteHabit(this.editingHabitId);
      this.habits = this.habits.filter(h => h.id !== this.editingHabitId);
      this.logs.delete(this.editingHabitId);
      this.closeModal('editHabitModal');
      this.render();
    });
  }

  // ============================================
  // Logging
  // ============================================

  async toggleLog(habitId, date) {
    if (date > this.formatDate(new Date())) return;
    let habitLogs = this.logs.get(habitId);
    if (!habitLogs) { habitLogs = new Map(); this.logs.set(habitId, habitLogs); }
    const current = habitLogs.get(date);
    const log = {
      habit_id: habitId, date,
      completed: !(current?.completed),
      note: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await db.setLog(log);
    habitLogs.set(date, log);
    if (this.currentView === 'grid') this.renderGrid();
    if (this.currentView === 'today') this.renderTodayView();
    this.renderHabitList();
  }

  async saveViewingDateNote(text) {
    const dateStr = this.viewingDate || this.formatDate(new Date());
    if (dateStr > this.formatDate(new Date())) return;
    if (text.trim()) {
      await db.setNote({ date: dateStr, note: text, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      this.notes.set(dateStr, text);
    } else {
      await db.deleteNote(dateStr);
      this.notes.delete(dateStr);
    }
  }

  // ============================================
  // Tooltip
  // ============================================

  showTooltip(event, habitName, date, completed, isFuture) {
    const tooltip = document.getElementById('tooltip');
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    tooltip.querySelector('.tooltip-date').textContent = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    tooltip.querySelector('.tooltip-habit').textContent = habitName;
    tooltip.querySelector('.tooltip-status').textContent = isFuture ? '○ Future' : completed ? '✓ Completed' : '○ Not completed';
    tooltip.style.left = `${event.pageX + 12}px`;
    tooltip.style.top = `${event.pageY + 12}px`;
    tooltip.classList.add('visible');
  }

  hideTooltip() { document.getElementById('tooltip').classList.remove('visible'); }

  // ============================================
  // Settings
  // ============================================

  openSettings() { document.getElementById('settingsModal').classList.add('active'); }

  async setTheme(theme) {
    this.settings.theme = theme;
    await db.setSetting('theme', theme);
    this.applyTheme();
  }

  applyTheme() {
    const theme = this.settings.theme;
    if (theme === 'system') {
      document.documentElement.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  async setAccentColor(color) {
    this.settings.accent = color;
    await db.setSetting('accent', color);
    document.documentElement.style.setProperty('--accent', color);
    document.querySelectorAll('#accentColors .color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === color));
  }

  async setDaysToShow(days) {
    this.settings.daysToShow = parseInt(days);
    await db.setSetting('daysToShow', days);
    this.renderGrid();
    requestAnimationFrame(() => this.resetView());
  }

  async exportData() {
    const data = {
      version: 1,
      exported_at: new Date().toISOString(),
      habits: await db.getHabits(true),
      logs: await db.getLogs(),
      notes: await db.getNotes()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ari-export-${this.formatDate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      if (data.version !== 1) {
        alert('Unsupported file version');
        return;
      }
      
      this.showConfirm('Import Data', 'This will merge with your existing data. Continue?', async () => {
        // Import habits
        for (const habit of data.habits || []) {
          await db.updateHabit(habit); // put() works for both insert and update
        }
        
        // Import logs
        for (const log of data.logs || []) {
          await db.setLog(log);
        }
        
        // Import notes
        for (const note of data.notes || []) {
          await db.setNote(note);
        }
        
        // Reload everything
        await this.loadHabits();
        await this.loadAllLogs();
        await this.loadNotes();
        this.render();
        this.closeModal('settingsModal');
      });
    } catch (e) {
      alert('Failed to import: ' + e.message);
    }
    
    event.target.value = ''; // Reset file input
  }

  async clearAllData() {
    this.showConfirm('Clear All Data', 'Permanently delete ALL habits, logs, and notes? This cannot be undone.', async () => {
      await db.clearAll();
      this.habits = [];
      this.logs = new Map();
      this.notes = new Map();
      this.closeModal('settingsModal');
      this.render();
    });
  }

  // ============================================
  // Modals
  // ============================================

  closeModal(id) {
    document.getElementById(id).classList.remove('active');
    if (id === 'editHabitModal') this.editingHabitId = null;
  }

  showConfirm(title, message, onConfirm) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmAction').onclick = () => { this.closeModal('confirmModal'); onConfirm(); };
    document.getElementById('confirmModal').classList.add('active');
  }

  // ============================================
  // Utilities
  // ============================================

  setDefaultDate() {
    const today = new Date();
    document.getElementById('newHabitStartDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '…' : str;
  }
}

// ============================================
// Initialize
// ============================================

const app = new AriApp();
document.addEventListener('DOMContentLoaded', () => app.init().catch(console.error));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (app.settings.theme === 'system') app.applyTheme();
});
