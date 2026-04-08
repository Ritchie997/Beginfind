// spa-router.js - Updated SPA router with proper partial loading

class SPARouter {
  constructor() {
    this.routes = {
      '/': this.loadDashboard,
      '/dashboard': this.loadDashboard,
      '/articles': this.loadArticles,
      '/categories': this.loadCategories,
      '/servers': this.loadServers,
      '/settings': this.loadSettings
    };

    this.currentView = null;
    this.loading = false;
    this.templateCache = new Map(); // Cache for fetched templates
    this.currentDraftId = null; // Track the currently loaded draft ID

    this.init();
  }

  // Getter для editorManager, чтобы всегда получать актуальный экземпляр
  get editorManager() {
    return window.editorManager || null;
  }

  init() {
    // Check authentication before initializing router
    this.checkAuthBeforeInit();
  }

  // Check authentication before initialization
  async checkAuthBeforeInit() {
    // Check authentication immediately, but with protection against circular redirects
    if (!authManager || !authManager.isAuthenticated()) {
      // If user is not authenticated, show login form
      // and don't continue router initialization
      showModalLogin();
      return;
    }

    // If authenticated, continue initialization
    this.completeInit();
  }

  completeInit() {
    // Set up navigation handlers
    this.setupNavigation();
    this.setupHistoryHandling();

    // Load current route
    this.navigateTo(window.location.pathname);
  }

  // Set up navigation handlers
  setupNavigation() {
    // Handler for clicks on navigation links/elements
    document.addEventListener('click', (e) => {
      // Check if click was on element with data-nav attribute (navigation)
      let navLink = e.target.closest('[data-nav]');
      if (navLink) {
        e.preventDefault();
        const route = navLink.getAttribute('data-nav');
        this.navigateTo(route);
        return;
      }

      // Also check sidebar menu items with onclick
      let sidebarItem = e.target.closest('.sidebar-item');
      if (sidebarItem) {
        e.preventDefault();

        // Get path from data-nav attribute or onclick
        let route = sidebarItem.getAttribute('data-nav');
        if (!route) {
          // Check onclick attribute if data-nav is not set
          const onclickAttr = sidebarItem.getAttribute('onclick');
          if (onclickAttr) {
            const match = onclickAttr.match(/window\.location\.href='([^']+)'/);
            if (match && match[1]) {
              route = match[1];
            }
          }
        }

        if (route) {
          this.navigateTo(route);
        }
      }
    });
  }

  // Set up browser history handling
  setupHistoryHandling() {
    // Handle browser back/forward buttons
    window.addEventListener('popstate', (event) => {
      this.navigateTo(window.location.pathname, false);
    });
  }

  // Main navigation function
  async navigateTo(path, updateHistory = true) {
    // If already loading a view, skip
    if (this.loading) return;

    this.loading = true;

    try {
      // Check authentication
      if (!authManager || !authManager.isAuthenticated()) {
        // Show login modal but don't redirect
        showModalLogin();
        this.loading = false;
        return;
      }

      // Normalize path for routing
      const normalizedPath = this.normalizePathForRouting(path);

      // Remove articles page class if we're navigating away from articles
      if (normalizedPath !== '/articles' && document.body.classList.contains('articles-page')) {
        document.body.classList.remove('articles-page');
      }

      // Find corresponding route handler
      const routeHandler = this.routes[normalizedPath];

      if (routeHandler) {
        // Update active menu item
        this.updateActiveMenuItem(normalizedPath);

        // Call route handler
        await routeHandler.call(this);

        // Update URL if needed
        if (updateHistory) {
          history.pushState({}, '', normalizedPath);
        }

        // Update page title
        this.updatePageTitle(normalizedPath);
      } else {
        // If route not found, redirect to dashboard
        this.navigateTo('/dashboard');
      }
    } catch (error) {
      console.error('Navigation error:', error);
      // On error, we can display a message to the user
      showMessage('Ошибка при загрузке страницы', 'error');
    } finally {
      this.loading = false;
    }
  }

  // Helper function to normalize paths for routing
  normalizePathForRouting(path) {
    if (!path) return '/';

    // If it's a full URL, extract only the path
    if (path.startsWith('http')) {
      try {
        const url = new URL(path);
        path = url.pathname;
      } catch (e) {
        // If URL parsing fails, use as is
        console.warn('Could not parse URL for routing:', path);
      }
    }

    // Remove trailing slashes, except for root path
    if (path !== '/' && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path;
  }

  // Update active menu item
  updateActiveMenuItem(path) {
    // Remove active class from all items
    const allSidebarItems = document.querySelectorAll('.sidebar-item');
    allSidebarItems.forEach(item => {
      item.classList.remove('active');
    });

    // Normalize current path for comparison
    const normalizedCurrentPath = this.normalizePathForMenu(path);

    // Add active class to corresponding item
    allSidebarItems.forEach(item => {
      // Check both data-nav attribute and onclick for compatibility
      let navPath = item.getAttribute('data-nav');
      if (!navPath) {
        navPath = this.getOnclickPath(item);
      }

      if (navPath) {
        const normalizedNavPath = this.normalizePathForMenu(navPath);

        // Compare paths with various options
        if (normalizedNavPath === normalizedCurrentPath) {
          item.classList.add('active');
        }
      }
    });
  }

  // Helper function to normalize paths for menu
  normalizePathForMenu(path) {
    if (!path) return '';

    // If it's a full URL, extract only the path
    if (path.startsWith('http')) {
      try {
        const url = new URL(path);
        path = url.pathname;
      } catch (e) {
        // If URL parsing fails, use as is
        console.warn('Could not parse URL:', path);
      }
    }

    // Remove trailing slashes for comparison
    if (path.endsWith('/') && path.length > 1) {
      path = path.slice(0, -1);
    }

    // Return normalized path
    return path;
  }

  // Helper function to extract path from onclick attribute for compatibility
  getOnclickPath(item) {
    const onclickAttr = item.getAttribute('onclick');
    if (onclickAttr) {
      const pathMatch = onclickAttr.match(/window\.location\.href='([^']+)'/);
      if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
      }
    }
    return null;
  }

  // Update page title
  updatePageTitle(path) {
    const titles = {
      '/': 'Дашборд - Админ-панель BeginFind',
      '/dashboard': 'Дашборд - Админ-панель BeginFind',
      '/articles': 'Статьи - Админ-панель BeginFind',
      '/categories': 'Категории - Админ-панель BeginFind',
      '/servers': 'Серверы - Админ-панель BeginFind',
      '/settings': 'Настройки - Админ-панель BeginFind'
    };

    const titleElement = document.getElementById('page-title');
    if (titleElement) {
      titleElement.textContent = titles[path] || 'Админ-панель BeginFind';
    }

    document.title = titles[path] || 'Админ-панель BeginFind';
  }

  // Load dashboard content
  async loadDashboard() {
    this.showLoader();

    try {
      // Load partial HTML for dashboard with caching
      const html = await this.loadTemplate('/views/dashboard.html');

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Дашборд';
        }
      }

      // Load dashboard stats
      await this.loadDashboardStats();

      // Note: Charts are now initialized in loadDashboardStats with real data
    } catch (error) {
      console.error('Error loading dashboard:', error);
      showMessage('Ошибка при загрузке дашборда', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Legacy method kept for compatibility - charts now initialized with real data in loadDashboardStats
  initDashboardCharts() {
    // This method is deprecated - use initDashboardChartsWithData instead
    console.log('initDashboardCharts is deprecated, use initDashboardChartsWithData');
  }

  // Load articles content
  async loadArticles() {
    this.showLoader();

    try {
      // Load partial HTML for articles
      const response = await fetch('/views/articles.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Статьи';
        }

        // Add specific class to body for article page styles
        document.body.classList.add('articles-page');
        
        // Force reflow to ensure styles are applied
        void appContent.offsetWidth;
      }

      // Initialize articles page functionality
      await this.initArticlesPage();
    } catch (error) {
      console.error('Error loading articles:', error);
      showMessage('Ошибка при загрузке статей', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load categories content
  async loadCategories() {
    this.showLoader();

    try {
      // Load partial HTML for categories
      const response = await fetch('/views/categories.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Категории';
        }
      }

      // Initialize categories page functionality
      await this.initCategoriesPage();
    } catch (error) {
      console.error('Error loading categories:', error);
      showMessage('Ошибка при загрузке категорий', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load servers content
  async loadServers() {
    this.showLoader();

    try {
      // Load partial HTML for servers
      const response = await fetch('/views/servers.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Серверы';
        }
      }

      // Initialize servers page functionality
      await this.initServersPage();
    } catch (error) {
      console.error('Error loading servers:', error);
      showMessage('Ошибка при загрузке серверов', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load settings content
  async loadSettings() {
    this.showLoader();

    try {
      // Load partial HTML for settings
      const response = await fetch('/views/settings.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Настройки';
        }
      }

      // Initialize settings page functionality
      await this.initSettingsPage();
    } catch (error) {
      console.error('Error loading settings:', error);
      showMessage('Ошибка при загрузке настроек', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Show loader with skeleton screens
  showLoader() {
    const appContent = document.getElementById('app-content');
    if (appContent) {
      // Use skeleton screens instead of plain "Loading..." text
      appContent.innerHTML = `
        <div style="padding: 20px;">
          <div class="skeleton" style="height: 30px; margin-bottom: 20px;"></div>
          <div class="skeleton" style="height: 100px; margin-bottom: 20px;"></div>
          <div class="skeleton" style="height: 100px; margin-bottom: 20px;"></div>
          <div class="skeleton" style="height: 100px;"></div>
        </div>
      `;
    }
  }

  // Hide loader
  hideLoader() {
    // Loading complete, nothing more to do
  }

  // Load template with caching
  async loadTemplate(templatePath) {
    const cacheKey = templatePath;
    const cached = this.templateCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5 minutes cache
      return cached.data;
    }

    try {
      const response = await fetch(templatePath);
      const html = await response.text();

      // Cache the template
      this.templateCache.set(cacheKey, {
        data: html,
        timestamp: Date.now()
      });

      return html;
    } catch (error) {
      console.error(`Error loading template ${templatePath}:`, error);
      throw error;
    }
  }

  // Initialize dashboard charts
  initDashboardCharts() {
    // Check if Chart.js is available
    if (typeof Chart !== 'undefined') {
      // Get the canvas element for weekly activity chart
      const ctx = document.getElementById('weeklyActivityChart');
      if (ctx) {
        // Destroy existing chart if it exists to avoid duplication
        if (ctx.chartInstance) {
          ctx.chartInstance.destroy();
        }

        // Create a sample chart (in a real scenario, this would be populated with actual data)
        const chartData = {
          labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
          datasets: [{
            label: 'Активность за неделю',
            data: [12, 19, 3, 5, 2, 3, 9],
            borderColor: 'rgb(86, 101, 242)',
            backgroundColor: 'rgba(86, 101, 242, 0.2)',
            tension: 0.1
          }]
        };

        const config = {
          type: 'line',
          data: chartData,
          options: {
            responsive: true,
            plugins: {
              legend: {
                position: 'top',
              }
            },
            scales: {
              y: {
                beginAtZero: true
              }
            }
          }
        };

        // Create the chart and store reference
        ctx.chartInstance = new Chart(ctx, config);
      }
    }
  }

  // Initialize articles page with all functionality
  async initArticlesPage() {
    // Load all required data
    await this.loadCategoriesForArticles();
    await this.loadRolesForArticles();
    await this.loadServersForArticles();
    await this.loadArticlesList();

    // Initialize editor
    const editorMgr = this.editorManager; // Use getter to get current editorManager
    if (editorMgr) {
      editorMgr.initializeEditor();

      // Set up improved editor events
      this.setupImprovedEditorEvents();
    } else {
      // Fallback: Initialize editor directly if editorManager is not available
      // This ensures editor events are set up even if editorManager fails to initialize
      if (typeof EditorManager !== 'undefined') {
        const localEditorManager = new EditorManager();
        localEditorManager.initializeEditor();
        this.setupImprovedEditorEvents();
      } else {
        // Last resort: Set up basic editor functionality directly
        this.setupBasicEditorEvents();
      }
    }

    // Set up event listeners for article form
    this.setupArticleFormEvents();

    // Check for and offer to load draft
    this.checkAndOfferDraft();
  }

  // Check for and offer to load draft if form is empty
  checkAndOfferDraft() {
    // Check if there's a draft in localStorage
    const draftData = localStorage.getItem('articleDraft');
    if (draftData) {
      try {
        const draft = JSON.parse(draftData);

        // Check if the current form is empty
        const title = document.getElementById('articleTitle').value;
        const content = document.getElementById('articleContent').innerHTML;
        const author = document.getElementById('articleAuthor').value;

        // If form is empty or nearly empty, offer to load the draft
        if (!title.trim() && !content.trim() && !author.trim()) {
          const timestamp = new Date(draft.timestamp).toLocaleString();
          const shouldLoad = confirm(`Найден черновик, сохраненный ${timestamp}. Загрузить его?`);
          if (shouldLoad) {
            this.loadDraft();
          }
        }
      } catch (error) {
        console.error('Error checking draft:', error);
      }
    }
  }

  // Set up basic editor events as a fallback
  setupBasicEditorEvents() {
    // Set up event listeners to update toolbar states when editor content changes
    const editor = document.getElementById('articleContent');
    if (editor) {
      // Add event listeners for updating toolbar states
      editor.addEventListener('keyup', this.updateToolbarUI.bind(this));
      editor.addEventListener('mouseup', this.updateToolbarUI.bind(this));
      editor.addEventListener('click', this.updateToolbarUI.bind(this));
      editor.addEventListener('input', this.updateToolbarUI.bind(this));
      editor.addEventListener('selectionchange', this.updateToolbarUI.bind(this));
    }
  }

  // Set up improved editor events
  setupImprovedEditorEvents() {
    // The editor manager handles all editor events now, so we don't need to set up our own
    // Just ensure the editor manager is properly initialized
    const editorMgr = this.editorManager; // Use getter
    if (editorMgr) {
      // The editor manager already handles toolbar events, formatting, and UI updates
      // We should only set up our own event listeners for editor content changes
      // but let editorManager handle toolbar button events
    }

    // Set up event listeners to update toolbar states when editor content changes
    // These will call our updateToolbarUI method which will use editorManager if available
    const editor = document.getElementById('articleContent');
    if (editor) {
      // Add event listeners for updating toolbar states
      editor.addEventListener('keyup', this.updateToolbarUI.bind(this));
      editor.addEventListener('mouseup', this.updateToolbarUI.bind(this));
      editor.addEventListener('click', this.updateToolbarUI.bind(this));
      editor.addEventListener('input', this.updateToolbarUI.bind(this));
      editor.addEventListener('selectionchange', this.updateToolbarUI.bind(this));
    }
  }

  // Setup toolbar event handlers

  // Apply formatting to editor content
  applyFormat(command) {
    // This method is now handled by editor-manager.js
    const editorMgr = this.editorManager; // Use getter
    if (editorMgr) {
      // Execute the command directly since formatText was removed
      document.execCommand(command, false, null);
      if (editorMgr.updateToolbarActiveStates) {
        editorMgr.updateToolbarActiveStates();
      }
      // Ensure editor has focus
      const editor = document.getElementById('articleContent');
      if (editor) {
        editor.focus();
      }
    } else {
      // Fallback implementation if editorManager is not available
      document.execCommand(command, false, null);
      this.updateToolbarUI(); // Use our own update method
      // Ensure editor has focus
      const editor = document.getElementById('articleContent');
      if (editor) {
        editor.focus();
      }
    }
  }

  // Update toolbar UI based on current selection
  updateToolbarUI() {
    // This method is now handled by editor-manager.js
    const editorMgr = this.editorManager; // Use getter
    if (editorMgr) {
      editorMgr.updateToolbarActiveStates();
    } else {
      // Fallback to direct implementation if editorManager is not available
      this.updateToolbarActiveStates();
    }
  }

  // Update toolbar active states based on current selection (for fallback implementation)
  updateToolbarActiveStates() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    // Check formatting states using document.queryCommandState
    const boldActive = document.queryCommandState('bold');
    const italicActive = document.queryCommandState('italic');
    const underlineActive = document.queryCommandState('underline');
    const strikethroughActive = document.queryCommandState('strikeThrough');
    const unorderedListActive = document.queryCommandState('insertUnorderedList');
    const orderedListActive = document.queryCommandState('insertOrderedList');

    // Update buttons with data-command attributes based on current formatting state
    const boldBtn = toolbar.querySelector('[data-command="bold"]');
    const italicBtn = toolbar.querySelector('[data-command="italic"]');
    const underlineBtn = toolbar.querySelector('[data-command="underline"]');
    const strikethroughBtn = toolbar.querySelector('[data-command="strikeThrough"]');
    const listBtn = toolbar.querySelector('[data-command="insertUnorderedList"]');
    const orderedListBtn = toolbar.querySelector('[data-command="insertOrderedList"]');

    if (boldBtn) {
      boldBtn.classList.toggle('active', boldActive);
    }
    if (italicBtn) {
      italicBtn.classList.toggle('active', italicActive);
    }
    if (underlineBtn) {
      underlineBtn.classList.toggle('active', underlineActive);
    }
    if (strikethroughBtn) {
      strikethroughBtn.classList.toggle('active', strikethroughActive);
    }
    if (listBtn) {
      // Special handling for list buttons to ensure mutual exclusivity
      listBtn.classList.toggle('active', unorderedListActive && !orderedListActive);
    }
    if (orderedListBtn) {
      // Special handling for list buttons to ensure mutual exclusivity
      orderedListBtn.classList.toggle('active', orderedListActive && !unorderedListActive);
    }
  }

  // Set up article form events
  setupArticleFormEvents() {
    // Set up tag input event
    const tagInput = document.getElementById('articleTags');
    if (tagInput) {
      tagInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.addTag();
        }
      });
    }

    // Set up all button events using event delegation
    document.getElementById('create-category-btn')?.addEventListener('click', () => this.createCategoryFromArticles());
    document.getElementById('add-tag-mobile-btn')?.addEventListener('click', () => this.addTag());
    document.getElementById('upload-image-btn')?.addEventListener('click', () => this.uploadImage());
    document.getElementById('saveArticleBtn')?.addEventListener('click', () => this.saveArticle());
    document.getElementById('saveDraftBtn')?.addEventListener('click', () => this.saveDraft());
    document.getElementById('loadDraftBtn')?.addEventListener('click', () => {
      // Show the drafts manager
      document.getElementById('draftsManager').style.display = 'block';
      this.displayDrafts();
    });
    document.getElementById('resetArticleBtn')?.addEventListener('click', () => {
      this.resetArticle();
    });
    document.getElementById('closeDraftsManagerBtn')?.addEventListener('click', () => {
      // Hide the drafts manager
      document.getElementById('draftsManager').style.display = 'none';
    });
    document.getElementById('clearArticleFormBtn')?.addEventListener('click', () => this.clearArticleForm());
    document.getElementById('previewArticleBtn')?.addEventListener('click', () => this.previewArticle());
    document.getElementById('closePreviewBtn')?.addEventListener('click', () => this.closePreview());
    document.getElementById('searchArticlesBtn')?.addEventListener('click', () => this.searchArticles());
    document.getElementById('resetSearchBtn')?.addEventListener('click', () => this.loadArticlesList());

    // Add change event listener for server selection to dynamically load roles
    document.getElementById('articleServer')?.addEventListener('change', (e) => {
        // For the old single-select role system (kept for compatibility with other parts of the code)
        this.loadRolesForSelectedServer(e.target.value);

        // For the new multi-role system, if the roles container is open, reload the roles
        const rolesContainer = document.getElementById('rolesContainer');
        if (rolesContainer && rolesContainer.style.display === 'block') {
            this.loadRolesForMultiSelection(e.target.value).catch(error => {
                console.error('Error loading roles for multi-selection:', error);
            });
        }
    });

    // Initialize multi-role selection UI
    this.initMultiRoleSelection();

    // Add beforeunload event listener to warn user about unsaved changes
    window.addEventListener('beforeunload', (e) => {
      // Check if there's content in the form that hasn't been saved
      const title = document.getElementById('articleTitle').value;
      const content = document.getElementById('articleContent').innerHTML;
      const author = document.getElementById('articleAuthor').value;

      // If there's content, warn the user about potential data loss
      if (title.trim() || content.trim() || author.trim()) {
        // Save draft automatically (synchronous approach for beforeunload)
        try {
          const articleData = {
            id: this.currentDraftId || 'draft_' + Date.now(), // Use current draft ID if editing, otherwise generate new ID
            title: title,
            author: author,
            category: document.getElementById('articleCategory').value,
            server: document.getElementById('articleServer').value,
            content: content,
            description: '',
            image: document.getElementById('articleImageFile')?.value || '',
            locked: document.getElementById('articleLocked')?.value === 'true',
            roles: JSON.parse(document.getElementById('articleRoles')?.value || '[]'),
            tags: this.getTagsFromForm(),
            timestamp: Date.now()
          };

          // Get existing drafts or initialize empty array
          let drafts = this.getDraftsFromStorage();

          // Check if we're updating an existing draft
          const existingDraftIndex = drafts.findIndex(draft => draft.id === this.currentDraftId);
          if (existingDraftIndex !== -1) {
            // Update existing draft
            drafts[existingDraftIndex] = articleData;
          } else {
            // Add new draft to the beginning of the array
            drafts.unshift(articleData);
          }

          // Save updated drafts array to localStorage
          localStorage.setItem('articleDrafts', JSON.stringify(drafts));

          // Update currentDraftId to the saved draft's ID
          this.currentDraftId = articleData.id;
        } catch (error) {
          console.error('Could not save draft before unload:', error);
        }

        // Show a warning to the user
        e.preventDefault();
        e.returnValue = 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?';
      }
    });
  }

  // Initialize categories page
  async initCategoriesPage() {
    await this.loadCategoriesList();
    this.setupCategoryFormEvents();
  }

  // Set up category form events
  setupCategoryFormEvents() {
    // Set up create category button
    document.getElementById('create-new-category-btn')?.addEventListener('click', () => this.createCategory());

    // Add Enter key support for the input field
    document.getElementById('newCategoryName')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.createCategory();
      }
    });
  }

  // Initialize servers page
  async initServersPage() {
    await this.loadServersList();
    this.setupServerFormEvents();
    this.setupServerPageResizeListener();
  }

  // Set up server form events
  setupServerFormEvents() {
    // Set up create server button
    document.getElementById('create-server-btn')?.addEventListener('click', () => this.showCreateServerModal());
    
    // Set up modal buttons
    document.getElementById('create-server-confirm-btn')?.addEventListener('click', () => this.createServer());
    document.getElementById('cancel-create-server-btn')?.addEventListener('click', () => this.hideCreateServerModal());
    
    // Close modal on outside click
    document.getElementById('create-server-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'create-server-modal') {
        this.hideCreateServerModal();
      }
    });
  }

  // Show create server modal
  showCreateServerModal() {
    const modal = document.getElementById('create-server-modal');
    if (modal) {
      modal.style.display = 'flex';
    }
  }

  // Hide create server modal
  hideCreateServerModal() {
    const modal = document.getElementById('create-server-modal');
    if (modal) {
      modal.style.display = 'none';
    }
    // Clear form fields
    document.getElementById('server-name').value = '';
    document.getElementById('server-description').value = '';
    document.getElementById('server-icon').value = '';
  }

  // Create server
  async createServer() {
    const name = document.getElementById('server-name').value.trim();
    const description = document.getElementById('server-description').value.trim();
    const icon = document.getElementById('server-icon').value.trim();

    if (!name) {
      showMessage('Название сервера обязательно', 'error');
      return;
    }

    try {
      const result = await apiClient.createServer({ name, description, icon });
      
      if (result.success) {
        showMessage('Сервер успешно создан!', 'success');
        this.hideCreateServerModal();
        await this.loadServersList();
      } else {
        showMessage(`Ошибка создания сервера: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка при создании сервера: ${error.message}`, 'error');
    }
  }

  // Initialize settings page
  async initSettingsPage() {
    this.setupSettingsFormEvents();
  }

  // Set up settings form events
  setupSettingsFormEvents() {
    document.getElementById('save-settings-btn')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('reset-settings-btn')?.addEventListener('click', () => this.resetSettings());
  }

  // Additional methods for handling articles functionality
  // (These would be implementations of the methods mentioned in setupArticleFormEvents)

  addTag() {
    const tagInput = document.getElementById('articleTags');
    const tagText = tagInput.value.trim();

    if (tagText && !document.getElementById(`tag-${tagText}`)) {
      const tagsContainer = document.getElementById('tagsContainer');
      if (tagsContainer) {
        const tagElement = document.createElement('span');
        tagElement.className = 'tag-item';
        tagElement.id = `tag-${tagText}`;
        tagElement.innerHTML = `${tagText} <span class="tag-remove" onclick="spaRouter.removeTag('${tagText}')">&times;</span>`;
        tagsContainer.appendChild(tagElement);

        // Show the tags container if it's hidden
        tagsContainer.style.display = 'flex';
      }
    }

    tagInput.value = '';
  }

  removeTag(tagText) {
    const tagElement = document.getElementById(`tag-${tagText}`);
    if (tagElement) {
      tagElement.remove();

      // Check if there are any remaining tags
      const tagsContainer = document.getElementById('tagsContainer');
      if (tagsContainer) {
        // If no more tag elements, hide the container
        if (tagsContainer.children.length === 0) {
          tagsContainer.style.display = 'none';
        }
      }
    }
  }

  selectCoverFromFile() {
    // Trigger the hidden file input
    const fileInput = document.getElementById('articleImageFileInput');
    fileInput.click();
  }

  handleCoverFileSelect(inputElement) {
    const file = inputElement.files[0];
    if (!file) {
      return;
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      showMessage('Пожалуйста, выберите файл изображения', 'error');
      return;
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      showMessage('Размер файла превышает допустимый лимит (5MB)', 'error');
      return;
    }

    // Create a preview using object URL
    const previewImg = document.getElementById('articleCoverImagePreview');
    const previewContainer = document.getElementById('articleCoverPreview');
    const fileNameElement = document.getElementById('coverFileName');

    if (previewImg) {
        previewImg.src = URL.createObjectURL(file);
    }

    if (fileNameElement) {
        fileNameElement.textContent = file.name;
    }

    if (previewContainer) {
        previewContainer.style.display = 'flex';
    }

    // Upload the file
    this.uploadCoverFile(file);
  }

  async uploadCoverFile(file) {
    const formData = new FormData();
    formData.append('image', file); // Ключ 'image' должен совпадать с тем, что ждет сервер

    try {
        const response = await fetch('/api/upload-image', { // ИСПРАВЛЕНО: правильный URL для загрузки изображений
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: formData
        });

        // Проверяем Content-Type ответа
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const textResponse = await response.text();
            console.error('Server returned non-JSON response:', textResponse.substring(0, 500));
            throw new Error('Сервер вернул некорректный ответ (не JSON). Проверьте логи сервера.');
        }

        const result = await response.json();
        if (response.ok) {
            // Update the hidden input field with the uploaded URL
            document.getElementById('articleImageFile').value = result.url;

            // Update the image preview to use the uploaded URL
            document.getElementById('articleCoverImagePreview').src = result.url;

            showMessage('Обложка успешно загружена!', 'success');
        } else {
            throw new Error(result.error || 'Ошибка сервера');
        }
    } catch (error) {
        console.error('Upload error:', error);
        showMessage('Ошибка при загрузке изображения: ' + error.message, 'error');
    }
  }

  selectCoverFromUrl() {
    const url = prompt("Введите URL изображения для обложки:");
    if (!url) {
      return; // User cancelled
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      showMessage('Пожалуйста, введите корректный URL изображения', 'error');
      return;
    }

    // Show image preview
    const previewImg = document.getElementById('articleCoverImagePreview');
    const previewContainer = document.getElementById('articleCoverPreview');
    const fileNameElement = document.getElementById('coverFileName');

    previewImg.src = url;
    fileNameElement.textContent = 'URL: ' + url.substring(0, 30) + (url.length > 30 ? '...' : '');
    previewContainer.style.display = 'flex';

    // Set the URL in the hidden input field for saving
    document.getElementById('articleImageFile').value = url;

    showMessage('Обложка установлена из URL!', 'success');
  }

  removeArticleCover() {
    const previewContainer = document.getElementById('articleCoverPreview');
    const fileInput = document.getElementById('articleImageFileInput');
    const hiddenInput = document.getElementById('articleImageFile');
    const fileNameElement = document.getElementById('coverFileName');

    previewContainer.style.display = 'none';
    fileInput.value = ''; // Clear the file input
    hiddenInput.value = '';
    fileNameElement.textContent = '';

    showMessage('Обложка удалена', 'info');
  }

  async uploadImage() {
    const fileInput = document.getElementById('articleCoverInput');
    if (!fileInput || !fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('image', fileInput.files[0]);

    try {
        // ИСПРАВЛЕНО: Используем правильный URL для загрузки изображений
        const response = await fetch('/api/upload-image', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: formData
        });

        const text = await response.text(); // Сначала читаем как текст
        try {
            const result = JSON.parse(text); // Пытаемся превратить в JSON
            if (response.ok && result.url) {
                document.getElementById('articleImagePreview').src = result.url;
                showMessage('Обложка загружена!', 'success');
            } else {
                showMessage('Ошибка сервера: ' + (result.error || 'Неизвестно'), 'error');
            }
        } catch (jsonErr) {
            console.error("Сервер ответил HTML-кодом вместо JSON. Вот ответ:", text);
            showMessage("Критическая ошибка: сервер прислал HTML. Возможно, путь /api/upload-image не существует.", 'error');
        }
    } catch (error) {
        console.error('Upload catch:', error);
        showMessage('Ошибка загрузки: ' + error.message, 'error');
    }
  }

  async saveArticle() {
    // 1. Ищем кнопку именно в текущем контейнере
    const saveBtn = document.getElementById('saveArticleBtn');
    // ВАЖНО: берем ID, который туда записал ArticlesModule.editArticle
    const articleId = saveBtn ? saveBtn.getAttribute('data-article-id') : null;

    console.log("Пытаюсь сохранить статью. ID:", articleId); // Для отладки

    const articleData = {
        title: document.getElementById('articleTitle').value,
        author: document.getElementById('articleAuthor').value,
        category: document.getElementById('articleCategory').value,
        server: document.getElementById('articleServer').value,
        content: document.getElementById('articleContent').innerHTML,
        description: '',
        image: document.getElementById('articleImageFile')?.value || '', // ИСПРАВЛЕНО: используем правильное поле для изображения
        locked: document.getElementById('articleLocked')?.value === 'true',
        roles: JSON.parse(document.getElementById('articleRoles')?.value || '[]'),
        tags: this.getTagsFromForm()
    };

    // 2. РЕШАЕМ: КУДА И КАК ШЛЕМ
    const method = articleId ? 'PUT' : 'POST';
    const url = articleId ? `/api/articles/${articleId}` : '/api/articles';

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: JSON.stringify(articleData)
        });

        // Проверяем, не прислал ли сервер HTML вместо JSON
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            const text = await response.text();
            console.error("Сервер прислал не JSON:", text);
            throw new Error("Сервер вернул ошибку (HTML). Проверьте путь /api/articles");
        }

        const result = await response.json();
        if (response.ok) {
            showMessage(articleId ? 'Статья успешно обновлена!' : 'Статья создана!', 'success');
            // Clear all drafts from localStorage after successful save
            localStorage.removeItem('articleDrafts');
            this.currentDraftId = null; // Clear current draft ID after successful save
            this.navigateTo('/articles');
        } else {
            showMessage(`Ошибка: ${result.error || 'Неизвестная ошибка'}`, 'error');
        }
    } catch (error) {
        console.error('Save error:', error);
        showMessage('Ошибка при сохранении: ' + error.message, 'error');
    }
  }

  clearArticleForm() {
    document.getElementById('articleTitle').value = '';
    document.getElementById('articleContent').innerHTML = '';
    document.getElementById('articleAuthor').value = '';
    document.getElementById('articleCategory').value = '';
    document.getElementById('articleTags').value = '';
    document.getElementById('tagsContainer').innerHTML = '';
    document.getElementById('tagsContainer').style.display = 'none';
    document.getElementById('articleImageFile').value = '';
    document.getElementById('articleImageFileInput').value = '';
    document.getElementById('articleCoverPreview').style.display = 'none';
    document.getElementById('coverFileName').textContent = '';
    document.getElementById('imagePreview').style.display = 'none';

    // Reset article status and trigger UI update
    const lockedSelect = document.getElementById('articleLocked');
    lockedSelect.value = 'false'; // Reset article status to unlocked (open)
    // Trigger change event to update UI
    const lockedChangeEvent = new Event('change', { bubbles: true });
    lockedSelect.dispatchEvent(lockedChangeEvent);

    // Reset roles to empty array
    document.getElementById('articleRoles').value = '[]';
    document.getElementById('selectedRolesDisplay').innerHTML = '';
    document.getElementById('selectedRolesDisplay').style.display = 'none';
    document.getElementById('rolesContainer').innerHTML = ''; // Clear the roles dropdown content
    document.getElementById('rolesContainer').style.display = 'none';
    document.getElementById('articleRolesInput').value = '';

    // Reset server field and trigger any related UI updates
    const serverSelect = document.getElementById('articleServer');
    serverSelect.value = ''; // Reset server field to default (empty/"No server")
    // Trigger change event to update any dependent UI
    const serverChangeEvent = new Event('change', { bubbles: true });
    serverSelect.dispatchEvent(serverChangeEvent);

    document.getElementById('draftsManager').style.display = 'none';
    this.currentDraftId = null; // Clear current draft ID

    // Reset to create mode
    document.getElementById('article-form-title').textContent = 'Создать новую статью';
    document.getElementById('saveArticleBtn').textContent = 'Опубликовать';
    document.getElementById('saveArticleBtn').removeAttribute('data-article-id');
  }

  saveDraft() {
    // Check if form is empty before saving
    const title = document.getElementById('articleTitle').value;
    const content = document.getElementById('articleContent').innerHTML;
    const author = document.getElementById('articleAuthor').value;

    // If form is empty, don't save a draft
    if (!title.trim() && !content.trim() && !author.trim()) {
      showMessage('Невозможно сохранить черновик: форма пуста', 'warning');
      return;
    }

    try {
      // Get all article data from the form
      const articleData = {
        id: this.currentDraftId || 'draft_' + Date.now(), // Use current draft ID if editing, otherwise generate new ID
        title: title,
        author: author,
        category: document.getElementById('articleCategory').value,
        server: document.getElementById('articleServer').value,
        content: content,
        description: '',
        image: document.getElementById('articleImageFile')?.value || '',
        locked: document.getElementById('articleLocked')?.value === 'true',
        roles: JSON.parse(document.getElementById('articleRoles')?.value || '[]'),
        tags: this.getTagsFromForm(),
        timestamp: Date.now() // Add timestamp for when draft was saved
      };

      // Get existing drafts or initialize empty array
      const drafts = this.getDraftsFromStorage();

      // Check if we're updating an existing draft
      const existingDraftIndex = drafts.findIndex(draft => draft.id === this.currentDraftId);
      if (existingDraftIndex !== -1) {
        // Update existing draft
        drafts[existingDraftIndex] = articleData;
      } else {
        // Add new draft to the beginning of the array
        drafts.unshift(articleData);
      }

      // Save updated drafts array to localStorage
      localStorage.setItem('articleDrafts', JSON.stringify(drafts));

      // Update currentDraftId to the saved draft's ID
      this.currentDraftId = articleData.id;

      // Show success message
      showMessage('Черновик успешно сохранен в локальное хранилище', 'success');
    } catch (error) {
      console.error('Error saving draft:', error);
      showMessage('Ошибка при сохранении черновика: ' + error.message, 'error');
    }
  }

  // Get drafts from localStorage
  getDraftsFromStorage() {
    try {
      const draftsData = localStorage.getItem('articleDrafts');
      if (draftsData) {
        return JSON.parse(draftsData);
      }
    } catch (error) {
      console.error('Error loading drafts from storage:', error);
    }
    return [];
  }

  // Load draft from localStorage if it exists
  loadDraft(draftId) {
    try {
      const drafts = this.getDraftsFromStorage();
      const draft = drafts.find(d => d.id === draftId);

      if (draft) {
        // Populate the form with draft data
        document.getElementById('articleTitle').value = draft.title || '';
        document.getElementById('articleAuthor').value = draft.author || '';
        document.getElementById('articleCategory').value = draft.category || '';

        // Handle server selection
        if (draft.server) {
          document.getElementById('articleServer').value = draft.server;
        }

        document.getElementById('articleContent').innerHTML = draft.content || '';

        // Handle image
        if (draft.image) {
          document.getElementById('articleImageFile').value = draft.image;

          // Restore cover image preview
          const previewImg = document.getElementById('articleCoverImagePreview');
          const previewContainer = document.getElementById('articleCoverPreview');
          const fileNameElement = document.getElementById('coverFileName');

          if (previewImg) {
            previewImg.src = draft.image;
          }

          if (fileNameElement) {
            // Extract filename from image path for display
            try {
              const imageUrl = new URL(draft.image);
              const pathname = imageUrl.pathname;
              const filename = pathname.split('/').pop();
              if (filename && filename.length > 0) {
                fileNameElement.textContent = filename;
              } else {
                fileNameElement.textContent = 'URL: ' + draft.image.substring(0, 30) + (draft.image.length > 30 ? '...' : '');
              }
            } catch (e) {
              // If it's not a valid URL, just use the string
              fileNameElement.textContent = draft.image.substring(0, 30) + (draft.image.length > 30 ? '...' : '');
            }
          }

          if (previewContainer) {
            previewContainer.style.display = 'flex';
          }
        }

        // Handle locked status
        if (draft.locked !== undefined) {
          document.getElementById('articleLocked').value = draft.locked ? 'true' : 'false';
        }

        // Handle roles
        if (draft.roles && Array.isArray(draft.roles)) {
          document.getElementById('articleRoles').value = JSON.stringify(draft.roles);

          // Load the server roles to populate the name mapping, then update the display
          if (draft.server) {
            // Load roles for the server to populate the name mapping
            this.loadRolesForMultiSelection(draft.server).then(() => {
              // After roles are loaded, update the display with proper names
              this.updateSelectedRolesDisplay(draft.roles);
            }).catch(e => {
              console.warn("Could not load server roles to map IDs to names:", e);
              // If we can't load the server roles, still try to display the IDs as-is
              this.updateSelectedRolesDisplay(draft.roles);
            });
          } else {
            // If no server is specified, just display the roles as they are
            this.updateSelectedRolesDisplay(draft.roles);
          }
        }

        // Handle tags
        if (draft.tags && Array.isArray(draft.tags)) {
          this.loadTagsToForm(draft.tags);
        }

        // Set the current draft ID to enable overwriting
        this.currentDraftId = draftId;

        // Show a message to the user
        const timestamp = new Date(draft.timestamp).toLocaleString();
        showMessage(`Загружен черновик "${draft.title || 'Без названия'}", сохраненный ${timestamp}`, 'info');

        return true;
      }
      return false;
    } catch (error) {
      console.error('Error loading draft:', error);
      showMessage('Ошибка при загрузке черновика', 'error');
      return false;
    }
  }

  // Check for and load draft if form is empty
  checkAndOfferDraft() {
    // Check if there's a draft in localStorage
    const drafts = this.getDraftsFromStorage();
    if (drafts && drafts.length > 0) {
      try {
        // Check if the current form is empty
        const title = document.getElementById('articleTitle').value;
        const content = document.getElementById('articleContent').innerHTML;
        const author = document.getElementById('articleAuthor').value;

        // If form is empty or nearly empty, load the most recent draft
        if (!title.trim() && !content.trim() && !author.trim()) {
          const latestDraft = drafts[0]; // Most recent draft
          this.loadDraft(latestDraft.id);
        }
      } catch (error) {
        console.error('Error checking draft:', error);
      }
    }
  }

  // Reset article form to empty state
  resetArticle() {
    if (confirm('Вы уверены, что хотите сбросить все данные формы?')) {
      // Clear all form fields
      document.getElementById('articleTitle').value = '';
      document.getElementById('articleContent').innerHTML = '';
      document.getElementById('articleAuthor').value = '';
      document.getElementById('articleCategory').value = '';
      document.getElementById('articleTags').value = '';
      document.getElementById('tagsContainer').innerHTML = '';
      document.getElementById('tagsContainer').style.display = 'none';
      document.getElementById('articleImageFile').value = '';
      document.getElementById('articleImageFileInput').value = '';
      document.getElementById('articleCoverPreview').style.display = 'none';
      document.getElementById('coverFileName').textContent = '';
      document.getElementById('imagePreview').style.display = 'none';

      // Reset article status and trigger UI update
      const lockedSelect = document.getElementById('articleLocked');
      lockedSelect.value = 'false'; // Reset article status to unlocked (open)
      // Trigger change event to update UI
      const lockedChangeEvent = new Event('change', { bubbles: true });
      lockedSelect.dispatchEvent(lockedChangeEvent);

      // Reset roles to empty array
      document.getElementById('articleRoles').value = '[]';
      document.getElementById('selectedRolesDisplay').innerHTML = '';
      document.getElementById('selectedRolesDisplay').style.display = 'none';
      document.getElementById('rolesContainer').innerHTML = ''; // Clear the roles dropdown content
      document.getElementById('rolesContainer').style.display = 'none';
      document.getElementById('articleRolesInput').value = '';

      // Reset server field and trigger any related UI updates
      const serverSelect = document.getElementById('articleServer');
      serverSelect.value = ''; // Reset server field to default (empty/"No server")
      // Trigger change event to update any dependent UI
      const serverChangeEvent = new Event('change', { bubbles: true });
      serverSelect.dispatchEvent(serverChangeEvent);

      // Reset form title and save button
      document.getElementById('article-form-title').textContent = 'Создать новую статью';
      document.getElementById('saveArticleBtn').textContent = 'Опубликовать';
      document.getElementById('saveArticleBtn').removeAttribute('data-article-id');

      // Hide drafts manager
      document.getElementById('draftsManager').style.display = 'none';

      // Clear current draft ID
      this.currentDraftId = null;

      showMessage('Форма сброшена до пустого состояния', 'info');
    }
  }

  // Display drafts in the drafts manager
  displayDrafts() {
    const draftsList = document.getElementById('draftsList');
    if (!draftsList) return;

    const drafts = this.getDraftsFromStorage();

    if (drafts.length === 0) {
      draftsList.innerHTML = '<div style="color: var(--header-secondary); padding: 10px; text-align: center;">Нет сохраненных черновиков</div>';
      return;
    }

    // Create HTML for each draft
    let draftsHtml = '';
    drafts.forEach((draft, index) => {
      const timestamp = new Date(draft.timestamp).toLocaleString();
      const title = draft.title || 'Без названия';

      draftsHtml += `
        <div class="draft-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid var(--background-accent);">
          <div style="flex: 1; cursor: pointer;" onclick="spaRouter.loadDraft('${draft.id}')">
            <div style="font-weight: bold; color: var(--text-normal);">${title}</div>
            <div style="font-size: 0.8em; color: var(--header-secondary);">${timestamp}</div>
          </div>
          <button class="btn btn-danger" style="padding: 4px 8px; margin-left: 8px;"
            onclick="spaRouter.deleteDraft('${draft.id}', event)">Удалить</button>
        </div>
      `;
    });

    draftsList.innerHTML = draftsHtml;
  }

  // Delete a specific draft
  deleteDraft(draftId, event) {
    event.stopPropagation(); // Prevent the click from loading the draft

    if (!confirm('Вы уверены, что хотите удалить этот черновик?')) {
      return;
    }

    try {
      let drafts = this.getDraftsFromStorage();
      drafts = drafts.filter(draft => draft.id !== draftId);

      // Save updated drafts array to localStorage
      localStorage.setItem('articleDrafts', JSON.stringify(drafts));

      // Update the display
      this.displayDrafts();
      showMessage('Черновик удален', 'success');
    } catch (error) {
      console.error('Error deleting draft:', error);
      showMessage('Ошибка при удалении черновика', 'error');
    }
  }

  previewArticle() {
    const title = document.getElementById('articleTitle').value;
    const author = document.getElementById('articleAuthor').value;
    const content = document.getElementById('articleContent').innerHTML;

    if (!title && !content) {
      showMessage('Пожалуйста, заполните заголовок и содержание статьи', 'error');
      return;
    }

    const previewContent = document.getElementById('previewContent');

    // Build preview content
    let previewHTML = '';

    // Add title
    if (title) {
      previewHTML += `<h1 style="color: #dcddde; margin: 10px 0;">${title}</h1>`;
    }

    // Add author if available
    if (author) {
      previewHTML += `<p style="color: #b9bbbe; margin: 8px 0; font-size: 0.9em;">Автор: ${author}</p>`;
    }

    // Add article preview image if available
    const articleImageValue = document.getElementById('articleImageFile')?.value;
    if (articleImageValue) {
      const imageUrl = this.getImageUrl(articleImageValue);
      if (imageUrl) {
        previewHTML += `<img src="${imageUrl}" alt="Превью статьи" style="max-width: 100%; border-radius: 4px; margin: 10px 0;">`;
      }
    }

    // Add content
    if (content) {
      previewHTML += `<div style="margin-top: 15px;">${content}</div>`;
    }

    previewContent.innerHTML = previewHTML;

    // Show the preview overlay
    const previewOverlay = document.getElementById('articlePreview');
    previewOverlay.classList.add('show');

    // Ensure spoiler functionality works in preview
    setTimeout(() => {
      // Initialize spoiler functionality for the preview content
      const spoilers = previewContent.querySelectorAll('mark[data-type="spoiler"]');
      spoilers.forEach(spoiler => {
        // Remove any existing event listeners to avoid duplicates
        spoiler.onclick = null;
        // Add click functionality to toggle revealed class
        spoiler.addEventListener('click', function(e) {
          e.stopPropagation();
          this.classList.toggle('revealed');
        });
      });
    }, 100); // Small delay to ensure DOM is updated
  }

  closePreview() {
    const previewOverlay = document.getElementById('articlePreview');
    previewOverlay.classList.remove('show');
  }

  async searchArticles() {
    const searchText = document.getElementById('searchText').value;

    if (!searchText || searchText.trim() === '') {
      // If search field is empty, load all articles
      await this.loadArticlesList();
      return;
    }

    try {
      const result = await apiClient.searchArticles(searchText);
      if (result.success) {
        const articles = result.data.data || result.data; // Support both formats
        const articlesListContainer = document.getElementById('articlesListContainer');
        if (articlesListContainer) {
          articlesListContainer.innerHTML = '';

          if (articles.length === 0) {
            articlesListContainer.innerHTML = '<p>Статьи не найдены</p>';
            return;
          }

          articles.forEach(article => {
            this.createArticleElement(article, articlesListContainer);
          });
        }
      } else {
        showMessage(`Ошибка при поиске статей: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Error:', error);
      showMessage(`Неожиданная ошибка при поиске статей: ${error.message}`, 'error');
    }
  }

  createArticleElement(article, container) {
    try {
      const articleDiv = document.createElement('div');
      articleDiv.className = 'article-item';

      // Create preview image if available
      let imagePreview = '';
      if (article.image) {
        try {
          const imageUrl = this.getImageUrl(article.image);
          if (imageUrl) {
            imagePreview = `<div class="article-image-preview">
                              <img src="${imageUrl}" alt="Превью статьи" class="article-image-thumb" onerror="this.style.display='none'">
                            </div>`;
          }
        } catch (imgError) {
          console.warn('Error getting image URL for article:', article.id, imgError);
        }
      }

      articleDiv.innerHTML = `
        <div class="article-title-container">
          ${imagePreview}
          <div class="article-title">${article.title}</div>
        </div>
        <div class="article-meta">
          <div class="meta-item"><strong>Автор:</strong> ${article.author || 'Не указан'}</div>
          <div class="meta-item"><strong>Категория:</strong> ${article.category || 'Не указана'}</div>
          <div class="meta-item"><strong>Сервер:</strong> ${article.server || 'Не указан'}</div>
          <div class="meta-item"><strong>Просмотры:</strong> ${article.views || 0}</div>
          <div class="meta-item"><strong>Статус:</strong> ${article.locked ? 'Закрытая' : 'Открытая'}</div>
          <div class="meta-item"><strong>ID:</strong> ${article.id}</div>
          <div class="meta-item"><strong>Создано:</strong> ${article.created_at}</div>
        </div>
        <div class="article-actions">
          <button class="btn btn-primary" onclick="window.spaRouter ? window.spaRouter.editArticle(${article.id}) : console.error('spaRouter not available')">Редактировать</button>
          <button class="btn btn-danger" onclick="window.spaRouter ? window.spaRouter.deleteArticle(${article.id}) : console.error('spaRouter not available')">Удалить</button>
        </div>
      `;
      container.appendChild(articleDiv);
    } catch (elementError) {
      console.error('Error creating article element:', article.id, elementError);
    }
  }

  // Edit article functionality
  async editArticle(articleId) {
    try {
      const result = await apiClient.getArticle(articleId);
      if (result.success) {
        const article = result.data;

        // Populate the form with article data
        const titleInput = document.getElementById('articleTitle');
        const authorInput = document.getElementById('articleAuthor');
        const categorySelect = document.getElementById('articleCategory');
        const serverSelect = document.getElementById('articleServer');
        const lockedSelect = document.getElementById('articleLocked');
        const roleSelect = document.getElementById('articleRole');
        const imageFileInput = document.getElementById('articleImageFile');

        if (titleInput) titleInput.value = article.title || '';
        if (authorInput) authorInput.value = article.author || '';
        if (categorySelect) categorySelect.value = article.category || '';
        if (serverSelect) {
            // Try to set by server ID first, then by server name
            if (article.server_id) {
                serverSelect.value = article.server_id;
            } else if (article.server) {
                // If server field contains a name, try to find corresponding option
                let found = false;
                for (let i = 0; i < serverSelect.options.length; i++) {
                    if (serverSelect.options[i].textContent === article.server) {
                        serverSelect.value = serverSelect.options[i].value;
                        found = true;
                        break;
                    }
                }
                // If name not found as option text, try direct value match (in case it's already an ID)
                if (!found) {
                    serverSelect.value = article.server;
                }
            } else {
                serverSelect.value = '';
            }
        }
        if (lockedSelect) lockedSelect.value = article.locked ? 'true' : 'false';
        // Handle roles as an array for the new multi-role system
        if (article.roles && Array.isArray(article.roles)) {
            // Set the hidden input with the roles array
            document.getElementById('articleRoles').value = JSON.stringify(article.roles);

            // Load the server roles to populate the name mapping, then update the display
            if (article.server || article.server_id) {
                // Use setTimeout to ensure DOM is updated before loading roles
                setTimeout(() => {
                    const serverForLoading = document.getElementById('articleServer').value || article.server_id || article.server;
                    if (serverForLoading) {
                        // Load roles to populate the mapping, then refresh the display
                        this.loadRolesForMultiSelection(serverForLoading).then(() => {
                            // Refresh the display to show role names instead of IDs
                            const currentRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');
                            this.updateSelectedRolesDisplay(currentRoles);
                        }).catch(e => {
                            console.warn("Could not load roles for server to display names:", e);
                            // If we can't load the roles, still display the IDs
                            this.updateSelectedRolesDisplay(article.roles);
                        });
                    } else {
                        // If no server is available, just display the roles as they are
                        this.updateSelectedRolesDisplay(article.roles);
                    }
                }, 100); // Small delay to ensure server selection is updated first
            } else {
                // If no server is specified, just display the roles as they are
                this.updateSelectedRolesDisplay(article.roles);
            }
        } else if (article.role) {
            // For backward compatibility, handle single role
            // If article.role is a JSON string, parse it; otherwise create array
            let rolesArray;
            if (typeof article.role === 'string' && article.role.startsWith('[') && article.role.endsWith(']')) {
                try {
                    rolesArray = JSON.parse(article.role);
                } catch (e) {
                    rolesArray = [article.role];
                }
            } else {
                rolesArray = [article.role];
            }

            document.getElementById('articleRoles').value = JSON.stringify(rolesArray);

            // Load server roles to populate name mapping, then update display
            if (article.server || article.server_id) {
                setTimeout(() => {
                    const serverForLoading = document.getElementById('articleServer').value || article.server_id || article.server;
                    if (serverForLoading) {
                        // Load roles to populate the mapping, then refresh the display
                        this.loadRolesForMultiSelection(serverForLoading).then(() => {
                            // Refresh the display to show role names instead of IDs
                            const currentRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');
                            this.updateSelectedRolesDisplay(currentRoles);
                        }).catch(e => {
                            console.warn("Could not load roles for server to display names:", e);
                            // If we can't load the roles, still display the IDs
                            this.updateSelectedRolesDisplay(rolesArray);
                        });
                    } else {
                        // If no server is available, just display the roles as they are
                        this.updateSelectedRolesDisplay(rolesArray);
                    }
                }, 100);
            } else {
                // If no server is specified, just display the roles as they are
                this.updateSelectedRolesDisplay(rolesArray);
            }
        } else {
            document.getElementById('articleRoles').value = '[]';
            this.updateSelectedRolesDisplay([]);
        }

        // Load tags for the article
        this.loadTagsToForm(article.tags || []);

        // If a server is specified, load its roles to populate the name mapping
        if (article.server || article.server_id) {
            // Use setTimeout to ensure DOM is updated before loading roles
            setTimeout(() => {
                const serverForLoading = document.getElementById('articleServer').value || article.server_id || article.server;
                if (serverForLoading) {
                    // Load roles to populate the mapping, then refresh the display
                    this.loadRolesForMultiSelection(serverForLoading).then(() => {
                        // Refresh the display to show role names instead of IDs
                        const currentRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');
                        this.updateSelectedRolesDisplay(currentRoles);
                    }).catch(e => {
                        console.warn("Could not load roles for server to display names:", e);
                    });
                }
            }, 100); // Small delay to ensure server selection is updated first
        }
        if (imageFileInput) imageFileInput.value = article.image || '';

        // Show cover preview if image exists
        if (article.image) {
          const previewImg = document.getElementById('articleCoverImagePreview');
          const previewContainer = document.getElementById('articleCoverPreview');
          const fileNameElement = document.getElementById('coverFileName');

          if (previewImg) previewImg.src = article.image;
          // Показываем только имя файла или короткую версию URL
          if (fileNameElement) {
              try {
                const imageUrl = new URL(article.image);
                const pathname = imageUrl.pathname;
                const filename = pathname.split('/').pop();
                if (filename && filename.length > 0) {
                  fileNameElement.textContent = filename;
                } else {
                  // Если нет имени файла, показываем укороченный URL
                  fileNameElement.textContent = 'URL: ' + article.image.substring(0, 30) + (article.image.length > 30 ? '...' : '');
                }
              } catch (e) {
                // Если URL некорректный, просто покажем начало строки
                fileNameElement.textContent = 'URL: ' + article.image.substring(0, 30) + (article.image.length > 30 ? '...' : '');
              }
          }
          if (previewContainer) previewContainer.style.display = 'flex';
        }

        // Set content in editor
        const editor = document.getElementById('articleContent');
        if (editor) {
          editor.innerHTML = article.content || '';
        }

        // Update form title and save button text
        const formTitle = document.getElementById('article-form-title');
        const saveBtn = document.getElementById('saveArticleBtn');

        if (formTitle) formTitle.textContent = 'Редактировать статью';
        if (saveBtn) {
            saveBtn.textContent = 'Обновить статью';
            saveBtn.setAttribute('data-article-id', articleId);
            console.log('Set article ID for editing:', articleId); // Debug log
        }

        // Hide the drafts manager and clear current draft ID when editing an article
        document.getElementById('draftsManager').style.display = 'none';
        this.currentDraftId = null; // Clear current draft ID when editing existing article

        // If article has a server, load server-specific roles
        if (article.server_id || article.server) {
          try {
            // Use the server ID for loading roles, fallback to name if ID not available
            let serverForRoles = article.server_id;
            if (!serverForRoles && article.server) {
                // Try to find the ID that corresponds to the server name
                for (let i = 0; i < serverSelect.options.length; i++) {
                    if (serverSelect.options[i].textContent === article.server) {
                        serverForRoles = serverSelect.options[i].value;
                        break;
                    }
                }
                // If we still don't have an ID, use the name as fallback
                if (!serverForRoles) {
                    serverForRoles = article.server;
                }
            }
            await this.loadRolesForSelectedServer(serverForRoles);
            // The roles are already loaded and will be set by the updateSelectedRolesDisplay call above
          } catch (roleError) {
            console.error('Error loading roles for server:', roleError);
            // Continue with edit even if roles failed to load
            // For backward compatibility, handle single role if roles array is not available
            if (article.role) {
                const rolesArray = [article.role];
                document.getElementById('articleRoles').value = JSON.stringify(rolesArray);
                this.updateSelectedRolesDisplay(rolesArray);
            } else {
                document.getElementById('articleRoles').value = '[]';
                this.updateSelectedRolesDisplay([]);
            }
          }
        } else {
          // If no server, just set the role value directly
          // For backward compatibility, handle single role if roles array is not available
          if (article.role) {
              const rolesArray = [article.role];
              document.getElementById('articleRoles').value = JSON.stringify(rolesArray);
              this.updateSelectedRolesDisplay(rolesArray);
          } else {
              document.getElementById('articleRoles').value = '[]';
              this.updateSelectedRolesDisplay([]);
          }
        }

        // Scroll to form
        const formContainer = document.querySelector('.form-container');
        if (formContainer) {
            formContainer.scrollIntoView({ behavior: 'smooth' });
        }
      } else {
        showMessage(`Ошибка загрузки статьи: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Error editing article:', error);
      showMessage('Ошибка при загрузке статьи для редактирования', 'error');
    }
  }

  // Delete article functionality
  async deleteArticle(articleId) {
    if (!confirm('Вы уверены, что хотите удалить эту статью?')) {
      return;
    }

    try {
      const result = await apiClient.deleteArticle(articleId);
      if (result.success) {
        showMessage('Статья успешно удалена!', 'success');
        // Reload the articles list to reflect the deletion
        await this.loadArticlesList();
      } else {
        showMessage(`Ошибка удаления статьи: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Error deleting article:', error);
      showMessage('Ошибка при удалении статьи', 'error');
    }
  }

  // Additional helper methods...
  getImageUrl(imagePath) {
    if (!imagePath) return null;

    // If it's already a full URL (external image), return as is
    if (imagePath.startsWith('http')) {
      return imagePath;
    }

    // If path already includes /uploads/, form full URL
    if (imagePath.includes('uploads')) {
      if (imagePath.startsWith('/')) {
        return `${window.location.origin}${imagePath}`;
      } else {
        return `${window.location.origin}/${imagePath}`;
      }
    }

    // If it's just a filename or path without /uploads/, add /uploads/
    if (!imagePath.startsWith('/')) {
      return `${window.location.origin}/uploads/${imagePath}`;
    } else {
      // If starts with / but not with /uploads/, add uploads
      if (!imagePath.startsWith('/uploads/')) {
        return `${window.location.origin}/uploads${imagePath}`;
      } else {
        return `${window.location.origin}${imagePath}`;
      }
    }
  }

  // Methods for loading data for articles page
  async loadCategoriesForArticles() {
    try {
      const result = await apiClient.getCategories();
      if (result.success) {
        const categorySelect = document.getElementById('articleCategory');
        if (categorySelect) {
          const selectedValue = categorySelect.value;

          // Clear list except first option
          categorySelect.innerHTML = '<option value="">Выберите категорию</option>';

          // Add categories from API
          result.data.forEach(category => {
            const option = document.createElement('option');
            option.value = category.name;
            option.textContent = category.name;
            categorySelect.appendChild(option);
          });

          // Restore selected value
          categorySelect.value = selectedValue;
        }
      } else {
        showMessage(`Ошибка загрузки категорий: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки категорий: ${error.message}`, 'error');
    }
  }

  async loadRolesForArticles() {
    try {
      const roleSelect = document.getElementById('articleRole');
      if (roleSelect) {
        const selectedValue = roleSelect.value;

        // Clear list and add only base roles
        roleSelect.innerHTML = '<option value="">Нет</option>';

        // Add observer role
        const observerOption = document.createElement('option');
        observerOption.value = 'observer';
        observerOption.textContent = 'Наблюдатель (только чтение)';
        roleSelect.appendChild(observerOption);

        // Add system roles: admin and user
        const systemRoles = [
          {value: 'admin', text: 'Администратор'},
          {value: 'user', text: 'Пользователь'}
        ];

        systemRoles.forEach(role => {
          const option = document.createElement('option');
          option.value = role.value;
          option.textContent = role.text;
          roleSelect.appendChild(option);
        });

        // Restore selected value
        roleSelect.value = selectedValue;
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки ролей: ${error.message}`, 'error');
    }
  }

  // Load roles specific to the selected server
  async loadRolesForSelectedServer(serverId) {
    const roleSelect = document.getElementById('articleRole');
    if (!roleSelect) return;

    // If no server is selected, reset to default roles
    if (!serverId) {
      // Load default roles
      await this.loadRolesForArticles();
      return;
    }

    try {
      // Disable the dropdown while loading
      roleSelect.disabled = true;

      // Fetch roles from the selected server
      const result = await apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);

      if (result.success) {
        const selectedValue = roleSelect.value;

        // Clear the dropdown
        roleSelect.innerHTML = '<option value="">Нет (глобальная роль)</option>';

        // Add server-specific roles
        result.data.forEach(role => {
          const option = document.createElement('option');
          option.value = role.id;
          option.textContent = role.name;

          // Apply role color if available
          if (role.color) {
            option.style.color = role.color;
          }

          roleSelect.appendChild(option);
        });

        // Restore selected value if it still exists, otherwise use default
        if (selectedValue) {
          roleSelect.value = selectedValue;
        }
      } else {
        showMessage(`Ошибка загрузки ролей сервера: ${result.error}`, 'error');
        // Load default roles on failure
        await this.loadRolesForArticles();
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки ролей сервера: ${error.message}`, 'error');
      // Load default roles on failure
      await this.loadRolesForArticles();
    } finally {
      // Re-enable the dropdown
      roleSelect.disabled = false;
    }
  }

  // Initialize the multi-role selection UI
  initMultiRoleSelection() {
    const rolesContainer = document.getElementById('rolesContainer');
    const rolesInput = document.getElementById('articleRolesInput');

    // Handle click on the input field to show roles container
    if (rolesInput) {
      rolesInput.addEventListener('click', (e) => {
        e.preventDefault();
        // Toggle the roles container
        const isVisible = rolesContainer.classList.contains('show');
        
        if (!isVisible) {
          // Show the roles container with animation
          rolesContainer.classList.add('show');
          rolesContainer.style.display = 'block';

          // Load roles for the selected server
          const serverSelect = document.getElementById('articleServer');
          if (serverSelect && serverSelect.value) {
            this.loadRolesForMultiSelection(serverSelect.value).catch(error => {
              console.error('Error loading roles for multi-selection:', error);
            });
          } else {
            // If no server is selected, show a message
            document.getElementById('rolesList').innerHTML = '<div style="color: var(--header-secondary); font-size: 14px; padding: 8px;">Сначала выберите сервер</div>';
          }

          // Ensure checkboxes are synchronized with selected roles
          setTimeout(() => {
            this.syncCheckboxesWithSelectedRoles();
          }, 50); // Small delay to ensure the list is populated and animation starts
        } else {
          // Hide with animation
          rolesContainer.classList.remove('show');
          setTimeout(() => {
            rolesContainer.style.display = 'none';
          }, 200); // Match transition duration
        }
      });

      // Clear the search input when clicking outside and closing the container
      rolesInput.addEventListener('blur', (e) => {
        setTimeout(() => {
          const isVisible = rolesContainer.classList.contains('show');
          if (!isVisible) {
            rolesInput.value = '';
          }
        }, 150); // Small delay to allow click events to process
      });
    }

    // Close the roles container when clicking outside
    document.addEventListener('click', (e) => {
      if (!rolesContainer.contains(e.target) && e.target !== rolesInput) {
        const isVisible = rolesContainer.classList.contains('show');
        if (isVisible) {
          rolesContainer.classList.remove('show');
          setTimeout(() => {
            rolesContainer.style.display = 'none';
          }, 200);
        }
        // Clear the search input when closing
        if (rolesInput) {
          rolesInput.value = '';
        }
      }
    });
  }

  // Load roles for multi-selection (checkboxes)
  loadRolesForMultiSelection(serverId) {
    return new Promise(async (resolve, reject) => {
      try {
        // Fetch roles from the selected server
        const result = await apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);
        const rolesList = document.getElementById('rolesList');

        if (result.success) {
          // Get currently selected roles to preserve them
          const selectedRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');

          // Store role ID to name mapping for later use
          this.roleIdToNameMap = {};
          result.data.forEach(role => {
            this.roleIdToNameMap[role.id] = role.name;
          });

          // Generate checkbox list for roles
          let rolesHtml = '';
          result.data.forEach(role => {
            // Check if role is selected by ID (primary check) or by name (for backward compatibility)
            const isRoleSelected = selectedRoles.includes(role.id) || selectedRoles.includes(role.name);
            rolesHtml += `
              <div class="role-checkbox-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0;">
                <input type="checkbox" id="role-${role.id}" value="${role.id}" ${isRoleSelected ? 'checked' : ''}
                  style="margin: 0;">
                <label for="role-${role.id}" style="margin: 0; flex: 1; color: var(--text-normal); cursor: pointer;">
                  ${role.name}
                </label>
              </div>
            `;
          });

          rolesList.innerHTML = rolesHtml;

          // Add event listeners to the checkboxes
          rolesList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
              this.updateSelectedRolesFromCheckboxes();
            });
          });

          // Add search functionality to the input field
          const rolesInput = document.getElementById('articleRolesInput');
          if (rolesInput) {
            // Remove any existing event listeners to prevent duplicates
            rolesInput.removeEventListener('input', this.roleSearchHandler);

            // Create a new handler function
            this.roleSearchHandler = (e) => {
              const searchTerm = e.target.value.toLowerCase().trim();

              // Get currently selected roles to preserve them during search
              const selectedRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');

              // Show/hide roles based on search term
              const roleItems = rolesList.querySelectorAll('.role-checkbox-item');
              roleItems.forEach(item => {
                const roleName = item.querySelector('label').textContent.toLowerCase();
                if (searchTerm === '' || roleName.includes(searchTerm)) {
                  item.style.display = 'flex';
                } else {
                  item.style.display = 'none';
                }

                // Ensure checkboxes reflect current selected state even when filtered
                const checkbox = item.querySelector('input[type="checkbox"]');
                if (checkbox) {
                  const roleId = checkbox.value;
                  checkbox.checked = selectedRoles.includes(roleId);
                }
              });
            };

            // Add the event listener
            rolesInput.addEventListener('input', this.roleSearchHandler);
          }
          resolve(); // Resolve the promise when successful
        } else {
          rolesList.innerHTML = `<div style="color: #ff6b6b; font-size: 14px; padding: 8px;">Ошибка загрузки ролей: ${result.error}</div>`;
          reject(new Error(result.error)); // Reject with the error
        }
      } catch (error) {
        console.error('Error loading roles for multi-selection:', error);
        const rolesList = document.getElementById('rolesList');
        rolesList.innerHTML = `<div style="color: #ff6b6b; font-size: 14px; padding: 8px;">Ошибка загрузки ролей: ${error.message}</div>`;
        reject(error); // Reject with the error
      }
    });
  }

  // Update checkboxes based on currently selected roles
  updateCheckboxesFromSelectedRoles() {
    const rolesList = document.getElementById('rolesList');
    const checkboxes = rolesList.querySelectorAll('input[type="checkbox"]');
    const selectedRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');

    checkboxes.forEach(checkbox => {
      const roleId = checkbox.value;
      const isChecked = selectedRoles.includes(roleId);
      checkbox.checked = isChecked;
    });
  }

  // Update selected roles based on checkboxes
  updateSelectedRolesFromCheckboxes() {
    const rolesList = document.getElementById('rolesList');
    const selectedCheckboxes = rolesList.querySelectorAll('input[type="checkbox"]:checked');
    const selectedRoles = Array.from(selectedCheckboxes).map(cb => cb.value);

    // Update the hidden input field
    document.getElementById('articleRoles').value = JSON.stringify(selectedRoles);

    // Update the display of selected roles
    this.updateSelectedRolesDisplay(selectedRoles);

    // Synchronize all checkboxes to ensure consistency
    this.syncCheckboxesWithSelectedRoles();
  }

  // Synchronize all checkboxes with the currently selected roles
  syncCheckboxesWithSelectedRoles() {
    const rolesList = document.getElementById('rolesList');
    const checkboxes = rolesList.querySelectorAll('input[type="checkbox"]');
    const selectedRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');

    checkboxes.forEach(checkbox => {
      const roleId = checkbox.value;
      const isChecked = selectedRoles.includes(roleId);
      checkbox.checked = isChecked;
    });
  }

  // Update the display of selected roles to expand horizontally like tags
  updateSelectedRolesDisplay(selectedRoles) {
    const displayContainer = document.getElementById('selectedRolesDisplay');

    if (selectedRoles.length === 0) {
      displayContainer.style.display = 'none';
      return;
    } else {
      displayContainer.style.display = 'flex';
    }

    displayContainer.innerHTML = ''; // Clear the container

    // Convert role IDs to names using the mapping, or keep as IDs if mapping not available yet
    const roleNames = selectedRoles.map(roleId => {
      // If it's already a name (string), return it; otherwise look up the name
      if (this.roleIdToNameMap && this.roleIdToNameMap[roleId]) {
        return this.roleIdToNameMap[roleId];
      } else {
        // If we don't have the mapping yet, try to fetch role info from the server
        // For now, we'll just return the ID, but in a real implementation we might fetch the name
        return roleId; // Return as-is if no mapping available
      }
    });

    // Set up the container to behave like tags
    displayContainer.style.display = 'flex';
    displayContainer.style.flexWrap = 'wrap';
    displayContainer.style.gap = '4px';
    displayContainer.style.marginTop = '0';

    // Add each role as a tag-like element
    roleNames.forEach((roleName, index) => {
      const roleId = selectedRoles[index];

      const roleElement = document.createElement('span');
      roleElement.className = 'role-tag-item';
      roleElement.innerHTML = `
        ${roleName}
        <span class="tag-remove">×</span>
      `;

      // Add event listener to the remove button
      const removeBtn = roleElement.querySelector('.tag-remove');
      removeBtn.onclick = (e) => {
        e.stopPropagation(); // Prevent event bubbling
        // Remove by ID, not by name
        this.removeSelectedRole(roleId);
      };

      displayContainer.appendChild(roleElement);
    });
  }

  // Convert role IDs to names - this function is no longer needed since we now work with role names directly
  // The roles array now contains role names, not IDs

  // Remove a selected role
  removeSelectedRole(roleIdToRemove) {
    const currentRoles = JSON.parse(document.getElementById('articleRoles').value || '[]');
    const updatedRoles = currentRoles.filter(roleId => roleId !== roleIdToRemove);

    // Update the hidden input
    document.getElementById('articleRoles').value = JSON.stringify(updatedRoles);

    // Update the display
    this.updateSelectedRolesDisplay(updatedRoles);

    // Synchronize all checkboxes with the current selected roles
    this.syncCheckboxesWithSelectedRoles();
  }

  async loadServersForArticles() {
    try {
      const result = await apiClient.makeAuthenticatedRequest('/api/servers');
      if (result.success) {
        const serverSelect = document.getElementById('articleServer');
        if (serverSelect) {
          const currentServerValue = serverSelect.value;

          // Clear list except first "None" option
          serverSelect.innerHTML = '<option value="">Нет</option>';

          // Add servers from API
          result.data.forEach(server => {
            const option = document.createElement('option');
            option.value = server.id;
            option.textContent = server.name;
            serverSelect.appendChild(option);
          });

          // Restore selected value
          serverSelect.value = currentServerValue;
        }
      } else {
        showMessage(`Ошибка загрузки серверов: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки серверов: ${error.message}`, 'error');
    }
  }

  async loadArticlesList() {
    try {
      const result = await apiClient.getArticles();
      if (result.success) {
        const articles = result.data;
        const articlesListContainer = document.getElementById('articlesListContainer');
        if (articlesListContainer) {
          articlesListContainer.innerHTML = '';

          if (articles.length === 0) {
            articlesListContainer.innerHTML = '<p>Нет статей</p>';
            return;
          }

          articles.forEach(article => {
            this.createArticleElement(article, articlesListContainer);
          });
        }
      } else {
        const articlesListContainer = document.getElementById('articlesListContainer');
        if (articlesListContainer) {
          articlesListContainer.innerHTML = '<p>Ошибка при загрузке статей</p>';
        }
        showMessage(`Ошибка загрузки статей: ${result.error}`, 'error');
      }
    } catch (error) {
      const articlesListContainer = document.getElementById('articlesListContainer');
      if (articlesListContainer) {
        articlesListContainer.innerHTML = '<p>Ошибка при загрузке статей</p>';
      }
      showMessage(`Неожиданная ошибка загрузки статей: ${error.message}`, 'error');
    }
  }

  // Category management methods
  async loadCategoriesList() {
    try {
      const result = await apiClient.getCategories();
      if (result.success) {
        // Update regular container
        const container = document.getElementById('categoriesContainer');
        if (container) {
          container.innerHTML = '';

          if (result.data.length === 0) {
            container.innerHTML = '<p>Нет категорий</p>';
            return;
          }

          result.data.forEach(category => {
            const categoryDiv = document.createElement('div');
            categoryDiv.className = 'article-item';
            categoryDiv.innerHTML = `
              <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <div style="flex: 1;">${category.name}</div>
                <div class="article-actions">
                  <button class="btn btn-danger" onclick="spaRouter.deleteCategory(${category.id}, '${category.name}')">Удалить</button>
                </div>
              </div>
            `;
            container.appendChild(categoryDiv);
          });
        }

        // Update card layout for mobile
        const cardLayout = document.getElementById('categories-card-layout');
        if (cardLayout) {
          cardLayout.innerHTML = '';

          if (result.data.length === 0) {
            cardLayout.innerHTML = '<p>Нет категорий</p>';
            return;
          }

          result.data.forEach(category => {
            const card = document.createElement('div');
            card.className = 'card-item-mobile';
            card.innerHTML = `
              <div class="card-header">
                <div class="card-title">${category.name}</div>
                <button class="btn btn-danger" onclick="spaRouter.deleteCategory(${category.id}, '${category.name}')">Удалить</button>
              </div>
            `;
            cardLayout.appendChild(card);
          });
        }
      } else {
        showMessage(`Ошибка загрузки категорий: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки категорий: ${error.message}`, 'error');
    }
  }

  async createCategory() {
    const inputElement = document.getElementById('newCategoryName');
    if (!inputElement) {
      showMessage('Поле ввода категории не найдено', 'error');
      return;
    }

    const categoryName = inputElement.value;
    if (!categoryName || categoryName.trim() === '') {
      showMessage('Пожалуйста, введите название категории', 'error');
      inputElement.focus();
      return;
    }

    try {
      const result = await apiClient.createCategory(categoryName.trim());
      if (result.success) {
        showMessage('Категория успешно создана!', 'success');
        inputElement.value = ''; // Clear the input field
        await this.loadCategoriesList(); // Reload list
        // Also reload categories in article form if on articles page
        if (document.getElementById('articleCategory')) {
          await this.loadCategoriesForArticles();
        }
      } else {
        showMessage('Ошибка при создании категории: ' + result.error, 'error');
      }
    } catch (error) {
      showMessage('Произошла ошибка при создании категории', 'error');
    }
  }

  async createCategoryFromArticles() {
    await this.createCategory();
  }

  async deleteCategory(id, name) {
    if (confirm(`Вы уверены, что хотите удалить категорию "${name}"?`)) {
      try {
        const result = await apiClient.deleteCategory(id);
        if (result.success) {
          showMessage('Категория успешно удалена!', 'success');
          await this.loadCategoriesList(); // Reload list
          // Also reload categories in article form if on articles page
          if (document.getElementById('articleCategory')) {
            await this.loadCategoriesForArticles();
          }
        } else {
          showMessage('Ошибка при удалении категории: ' + result.data.error, 'error');
        }
      } catch (error) {
        showMessage('Произошла ошибка при удалении категории', 'error');
      }
    }
  }

  // Server management methods - Complete rewrite with full functionality
  async loadServersList() {
    try {
      const result = await apiClient.makeAuthenticatedRequest('/api/servers');

      if (result.success) {
        // Update table view (desktop)
        const tbody = document.getElementById('servers-tbody');
        if (tbody) {
          tbody.innerHTML = '';

          if (result.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-muted);">Серверы не найдены. Создайте первый сервер!</td></tr>';
          } else {
            result.data.forEach(server => {
              const row = document.createElement('tr');
              const userCount = server.user_count || 0;

              row.innerHTML = `
                <td>${server.id}</td>
                <td><strong>${this.escapeHtml(server.name)}</strong></td>
                <td>${server.owner_username || 'N/A'}</td>
                <td>${new Date(server.created_at).toLocaleDateString()}</td>
                <td>${userCount}</td>
                <td>
                  <button class="btn btn-primary btn-sm" onclick="spaRouter.viewServerDetails(${server.id})">Управление</button>
                  <button class="btn btn-danger btn-sm" onclick="spaRouter.deleteServer(${server.id})" style="margin-left: 5px;">Удалить</button>
                </td>
              `;

              tbody.appendChild(row);
            });
          }
        }

        // Update card layout for mobile ONLY
        this.updateMobileCardLayout(result.data);
      } else {
        showMessage(`Ошибка загрузки серверов: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка при загрузке серверов: ${error.message}`, 'error');
    }
  }

  // Update mobile card layout based on screen size
  updateMobileCardLayout(servers) {
    const cardLayout = document.getElementById('servers-card-layout');
    if (!cardLayout) return;

    // Only populate card layout on mobile
    if (window.innerWidth <= 768) {
      cardLayout.innerHTML = '';

      if (servers.length === 0) {
        cardLayout.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">Серверы не найдены. Создайте первый сервер!</div>';
      } else {
        servers.forEach(server => {
          const card = document.createElement('div');
          card.className = 'card-item-mobile';
          const userCount = server.user_count || 0;

          card.innerHTML = `
            <div class="card-header">
              <div class="card-title">${this.escapeHtml(server.name)}</div>
              <button class="btn btn-primary btn-sm" onclick="spaRouter.viewServerDetails(${server.id})">Управление</button>
            </div>
            <div class="card-content">
              <div class="meta-item"><strong>ID:</strong> ${server.id}</div>
              <div class="meta-item"><strong>Владелец:</strong> ${server.owner_username || 'N/A'}</div>
              <div class="meta-item"><strong>Участников:</strong> ${userCount}</div>
              <div class="meta-item"><strong>Дата создания:</strong> ${new Date(server.created_at).toLocaleDateString()}</div>
            </div>
            <div class="card-actions" style="margin-top: 10px; text-align: right;">
              <button class="btn btn-danger btn-sm" onclick="spaRouter.deleteServer(${server.id})">Удалить</button>
            </div>
          `;

          cardLayout.appendChild(card);
        });
      }
    } else {
      // Clear card layout on desktop to prevent duplicates
      cardLayout.innerHTML = '';
    }
  }

  // Set up resize listener for mobile/desktop switching
  setupServerPageResizeListener() {
    if (this.serverResizeListenerAttached) return;
    
    window.addEventListener('resize', () => {
      // Re-render the appropriate layout when crossing the breakpoint
      const currentPath = window.location.pathname;
      if (currentPath === '/servers' || currentPath === '/') {
        // Reload the server list to update layouts
        this.loadServersList();
      }
    });
    
    this.serverResizeListenerAttached = true;
  }

  // View server details in modal
  async viewServerDetails(serverId) {
    try {
      // Load server details
      const serverResult = await apiClient.getServer(serverId);
      if (!serverResult.success) {
        showMessage('Ошибка загрузки информации о сервере', 'error');
        return;
      }

      const server = serverResult.data;

      // Load members and roles
      const membersResult = await apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/users`);
      const rolesResult = await apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);

      const members = membersResult.success ? membersResult.data : [];
      const roles = rolesResult.success ? rolesResult.data : [];

      // Create modal HTML
      const modalHtml = `
        <div id="server-details-modal" class="modal" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 2000; align-items: center; justify-content: center;">
          <div style="background: var(--background-secondary); padding: 0; border-radius: 8px; width: 900px; max-width: 95%; max-height: 90vh; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid var(--background-accent); display: flex; flex-direction: column;">
            <!-- Header -->
            <div style="padding: 20px; border-bottom: 1px solid var(--background-accent); display: flex; justify-content: space-between; align-items: center; background: var(--background-tertiary);">
              <div>
                <h2 style="margin: 0; color: var(--header-primary);">${this.escapeHtml(server.name)}</h2>
                <p style="margin: 5px 0 0 0; color: var(--text-muted); font-size: 14px;">${server.description || 'Описание отсутствует'}</p>
              </div>
              <button class="btn btn-danger btn-sm" onclick="spaRouter.closeServerDetailsModal()">✕</button>
            </div>

            <!-- Tabs -->
            <div style="display: flex; border-bottom: 1px solid var(--background-accent); background: var(--background-secondary);">
              <button class="tab-button active" onclick="spaRouter.switchServerTab('members')" style="flex: 1; padding: 15px; background: none; border: none; cursor: pointer; color: var(--text-muted); border-bottom: 2px solid transparent;" id="tab-btn-members">
                <strong>Участники (${members.length})</strong>
              </button>
              <button class="tab-button" onclick="spaRouter.switchServerTab('roles')" style="flex: 1; padding: 15px; background: none; border: none; cursor: pointer; color: var(--text-muted); border-bottom: 2px solid transparent;" id="tab-btn-roles">
                <strong>Роли (${roles.length})</strong>
              </button>
              <button class="tab-button" onclick="spaRouter.switchServerTab('settings')" style="flex: 1; padding: 15px; background: none; border: none; cursor: pointer; color: var(--text-muted); border-bottom: 2px solid transparent;" id="tab-btn-settings">
                <strong>Настройки</strong>
              </button>
            </div>

            <!-- Content -->
            <div style="flex: 1; overflow-y: auto; padding: 20px;" id="server-tab-content">
              <!-- Members Tab -->
              <div id="tab-members" class="server-tab-content">
                <div style="margin-bottom: 15px;">
                  <button class="btn btn-primary btn-sm" onclick="spaRouter.showAddMemberModal(${serverId})">Добавить участника</button>
                </div>
                <div class="table-container" style="background: var(--background-tertiary); border-radius: 4px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                      <tr style="border-bottom: 1px solid var(--background-accent);">
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">ID</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Пользователь</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Роли</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Дата вступления</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${members.length === 0 ? '<tr><td colspan="5" style="padding: 30px; text-align: center; color: var(--text-muted);">Нет участников</td></tr>' : 
                        members.map(member => `
                          <tr style="border-bottom: 1px solid var(--background-accent);">
                            <td style="padding: 12px;">${member.id}</td>
                            <td style="padding: 12px;"><strong>${this.escapeHtml(member.username)}</strong></td>
                            <td style="padding: 12px;">
                              ${member.roles && member.roles.length > 0 ? 
                                member.roles.map(role => `<span class="role-tag" style="display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 5px; background: ${role.role_type === 'system' ? '#5865f2' : '#eb459e'}; color: white;">${this.escapeHtml(role.name)}</span>`).join('') : 
                                '<span style="color: var(--text-muted);">Нет ролей</span>'}
                            </td>
                            <td style="padding: 12px;">${new Date(member.joined_at).toLocaleDateString()}</td>
                            <td style="padding: 12px;">
                              ${member.id !== server.owner_id ? 
                                `<button class="btn btn-danger btn-sm" onclick="spaRouter.removeMember(${serverId}, ${member.id})">Удалить</button>` : 
                                '<span style="color: var(--text-muted); font-size: 12px;">Владелец</span>'}
                            </td>
                          </tr>
                        `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Roles Tab -->
              <div id="tab-roles" class="server-tab-content" style="display: none;">
                <div style="margin-bottom: 15px;">
                  <button class="btn btn-primary btn-sm" onclick="spaRouter.showCreateRoleModal(${serverId})">Создать роль</button>
                </div>
                <div class="table-container" style="background: var(--background-tertiary); border-radius: 4px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                      <tr style="border-bottom: 1px solid var(--background-accent);">
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Название</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Тип</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Код</th>
                        <th style="padding: 12px; text-align: left; color: var(--header-secondary);">Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${roles.length === 0 ? '<tr><td colspan="4" style="padding: 30px; text-align: center; color: var(--text-muted);">Нет ролей</td></tr>' : 
                        roles.map(role => `
                          <tr style="border-bottom: 1px solid var(--background-accent);">
                            <td style="padding: 12px;"><strong>${this.escapeHtml(role.name)}</strong></td>
                            <td style="padding: 12px;"><span class="role-tag" style="background: ${role.role_type === 'system' ? '#5865f2' : '#eb459e'}; color: white;">${role.role_type === 'system' ? 'Системная' : 'Пользовательская'}</span></td>
                            <td style="padding: 12px; font-family: monospace; color: var(--text-muted);">${role.code}</td>
                            <td style="padding: 12px;">
                              ${role.role_type !== 'system' ? 
                                `<button class="btn btn-danger btn-sm" onclick="spaRouter.deleteRole(${serverId}, ${role.id})">Удалить</button>` : 
                                '<span style="color: var(--text-muted); font-size: 12px;">Нельзя удалить</span>'}
                            </td>
                          </tr>
                        `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Settings Tab -->
              <div id="tab-settings" class="server-tab-content" style="display: none;">
                <div class="form-group" style="margin-bottom: 20px;">
                  <label style="display: block; margin-bottom: 8px; color: var(--header-primary); font-weight: 500;">Название сервера</label>
                  <input type="text" id="edit-server-name" value="${this.escapeHtml(server.name)}" style="width: 100%; padding: 10px; border-radius: 4px; background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--background-accent);">
                </div>
                <div class="form-group" style="margin-bottom: 20px;">
                  <label style="display: block; margin-bottom: 8px; color: var(--header-primary); font-weight: 500;">Описание</label>
                  <textarea id="edit-server-description" rows="3" style="width: 100%; padding: 10px; border-radius: 4px; background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--background-accent);">${server.description || ''}</textarea>
                </div>
                <div class="btn-group">
                  <button class="btn btn-primary" onclick="spaRouter.updateServer(${serverId})">Сохранить изменения</button>
                  <button class="btn btn-danger" onclick="spaRouter.deleteServer(${serverId}, true)">Удалить сервер</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      // Add modal to body
      const existingModal = document.getElementById('server-details-modal');
      if (existingModal) {
        existingModal.remove();
      }
      document.body.insertAdjacentHTML('beforeend', modalHtml);

      // Store current server ID
      this.currentViewingServerId = serverId;

    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Close server details modal
  closeServerDetailsModal() {
    const modal = document.getElementById('server-details-modal');
    if (modal) {
      modal.remove();
    }
    this.currentViewingServerId = null;
  }

  // Switch server tab
  switchServerTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.server-tab-content').forEach(tab => {
      tab.style.display = 'none';
    });
    
    // Remove active class from all buttons
    document.querySelectorAll('[id^="tab-btn-"]').forEach(btn => {
      btn.classList.remove('active');
      btn.style.borderBottomColor = 'transparent';
      btn.style.color = 'var(--text-muted)';
    });

    // Show selected tab
    const selectedTab = document.getElementById(`tab-${tabName}`);
    if (selectedTab) {
      selectedTab.style.display = 'block';
    }

    // Add active class to selected button
    const selectedBtn = document.getElementById(`tab-btn-${tabName}`);
    if (selectedBtn) {
      selectedBtn.classList.add('active');
      selectedBtn.style.borderBottomColor = 'var(--blurple)';
      selectedBtn.style.color = 'var(--header-primary)';
    }
  }

  // Show add member modal
  showAddMemberModal(serverId) {
    const modalHtml = `
      <div id="add-member-modal" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 3000; align-items: center; justify-content: center;">
        <div style="background: var(--background-secondary); padding: 25px; border-radius: 8px; width: 500px; max-width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid var(--background-accent);">
          <h3 style="margin-top: 0; color: var(--header-primary);">Добавить участника</h3>
          <div class="form-group" style="margin: 20px 0;">
            <label style="display: block; margin-bottom: 8px; color: var(--header-primary);">ID пользователя</label>
            <input type="number" id="new-member-id" placeholder="Введите ID пользователя" style="width: 100%; padding: 10px; border-radius: 4px; background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--background-accent);">
          </div>
          <div class="btn-group" style="justify-content: flex-end;">
            <button class="btn btn-primary" onclick="spaRouter.addMember(${serverId})">Добавить</button>
            <button class="btn btn-secondary" onclick="document.getElementById('add-member-modal').remove()" style="background: var(--background-accent); color: var(--text-normal);">Отмена</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  // Add member to server
  async addMember(serverId) {
    const userId = document.getElementById('new-member-id').value.trim();
    if (!userId) {
      showMessage('Введите ID пользователя', 'error');
      return;
    }

    try {
      const result = await apiClient.addServerUser(serverId, userId);
      if (result.success) {
        showMessage('Пользователь добавлен', 'success');
        document.getElementById('add-member-modal').remove();
        await this.viewServerDetails(serverId); // Refresh
      } else {
        showMessage(`Ошибка: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Remove member from server
  async removeMember(serverId, userId) {
    if (!confirm('Удалить участника из сервера?')) return;

    try {
      const result = await apiClient.removeServerUser(serverId, userId);
      if (result.success) {
        showMessage('Участник удален', 'success');
        await this.viewServerDetails(serverId); // Refresh
      } else {
        showMessage(`Ошибка: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Show create role modal
  showCreateRoleModal(serverId) {
    const modalHtml = `
      <div id="create-role-modal" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 3000; align-items: center; justify-content: center;">
        <div style="background: var(--background-secondary); padding: 25px; border-radius: 8px; width: 500px; max-width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid var(--background-accent);">
          <h3 style="margin-top: 0; color: var(--header-primary);">Создать роль</h3>
          <div class="form-group" style="margin: 20px 0;">
            <label style="display: block; margin-bottom: 8px; color: var(--header-primary);">Название роли</label>
            <input type="text" id="new-role-name" placeholder="Например: Модератор" style="width: 100%; padding: 10px; border-radius: 4px; background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--background-accent);">
          </div>
          <div class="form-group" style="margin: 20px 0;">
            <label style="display: block; margin-bottom: 8px; color: var(--header-primary);">Код роли (латиницей)</label>
            <input type="text" id="new-role-code" placeholder="Например: moderator" style="width: 100%; padding: 10px; border-radius: 4px; background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--background-accent);">
          </div>
          <div class="btn-group" style="justify-content: flex-end;">
            <button class="btn btn-primary" onclick="spaRouter.createRole(${serverId})">Создать</button>
            <button class="btn btn-secondary" onclick="document.getElementById('create-role-modal').remove()" style="background: var(--background-accent); color: var(--text-normal);">Отмена</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  // Create role on server
  async createRole(serverId) {
    const name = document.getElementById('new-role-name').value.trim();
    const code = document.getElementById('new-role-code').value.trim();

    if (!name || !code) {
      showMessage('Заполните все поля', 'error');
      return;
    }

    try {
      const result = await apiClient.createServerRole(serverId, { name, code });
      if (result.success) {
        showMessage('Роль создана', 'success');
        document.getElementById('create-role-modal').remove();
        await this.viewServerDetails(serverId); // Refresh
      } else {
        showMessage(`Ошибка: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Delete role from server
  async deleteRole(serverId, roleId) {
    if (!confirm('Удалить эту роль?')) return;

    try {
      const result = await apiClient.deleteServerRole(serverId, roleId);
      if (result.success) {
        showMessage('Роль удалена', 'success');
        await this.viewServerDetails(serverId); // Refresh
      } else {
        showMessage(`Ошибка: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Update server settings
  async updateServer(serverId) {
    const name = document.getElementById('edit-server-name').value.trim();
    const description = document.getElementById('edit-server-description').value.trim();

    if (!name) {
      showMessage('Название сервера обязательно', 'error');
      return;
    }

    try {
      const result = await apiClient.updateServer(serverId, { name, description });
      if (result.success) {
        showMessage('Сервер обновлен', 'success');
        await this.viewServerDetails(serverId); // Refresh
        await this.loadServersList(); // Refresh main list
      } else {
        showMessage(`Ошибка: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Delete server
  async deleteServer(serverId, fromDetails = false) {
    if (!confirm('Вы уверены, что хотите удалить этот сервер? Это действие нельзя отменить!')) return;

    try {
      const result = await apiClient.deleteServer(serverId);
      if (result.success) {
        showMessage('Сервер удален', 'success');
        if (fromDetails) {
          this.closeServerDetailsModal();
        }
        await this.loadServersList(); // Refresh main list
      } else {
        showMessage(`Ошибка: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Helper method to escape HTML
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Settings methods
  saveSettings() {
    // Gather settings from form
    const settings = {
      systemName: document.getElementById('systemName')?.value,
      systemDescription: document.getElementById('systemDescription')?.value,
      maxFileSize: document.getElementById('maxFileSize')?.value,
      allowRegistration: document.getElementById('allowRegistration')?.checked,
      articlesPerPage: document.getElementById('articlesPerPage')?.value,
      theme: document.getElementById('theme')?.value
    };

    // Save settings to local storage or server
    localStorage.setItem('appSettings', JSON.stringify(settings));
    showMessage('Настройки успешно сохранены!', 'success');
  }

  resetSettings() {
    if (confirm('Вы уверены, что хотите сбросить все настройки к значениям по умолчанию?')) {
      // Reset form to default values
      document.getElementById('systemName').value = 'BeginFind Admin Panel';
      document.getElementById('systemDescription').value = 'Административная панель управления системой BeginFind';
      document.getElementById('maxFileSize').value = '5';
      document.getElementById('allowRegistration').checked = true;
      document.getElementById('articlesPerPage').value = '20';
      document.getElementById('theme').value = 'dark';

      // Save to local storage
      localStorage.removeItem('appSettings');
      showMessage('Настройки сброшены к значениям по умолчанию!', 'success');
    }
  }

  // Initialize settings form with saved values
  initSettingsForm() {
    const savedSettings = localStorage.getItem('appSettings');
    if (savedSettings) {
      const settings = JSON.parse(savedSettings);

      if (settings.systemName) document.getElementById('systemName').value = settings.systemName;
      if (settings.systemDescription) document.getElementById('systemDescription').value = settings.systemDescription;
      if (settings.maxFileSize) document.getElementById('maxFileSize').value = settings.maxFileSize;
      if (settings.allowRegistration !== undefined) document.getElementById('allowRegistration').checked = settings.allowRegistration;
      if (settings.articlesPerPage) document.getElementById('articlesPerPage').value = settings.articlesPerPage;
      if (settings.theme) document.getElementById('theme').value = settings.theme;
    }
  }

  // Set up settings form events with auto-save
  setupSettingsFormEvents() {
    // Initialize form with saved values
    this.initSettingsForm();

    // Set up auto-save for simple settings
    const autoSaveInputs = [
      'systemName', 'systemDescription', 'maxFileSize',
      'articlesPerPage', 'theme', 'allowRegistration'
    ];

    autoSaveInputs.forEach(inputId => {
      const element = document.getElementById(inputId);
      if (element) {
        // For checkboxes, listen to change event
        if (element.type === 'checkbox') {
          element.addEventListener('change', debounce(() => {
            this.saveSettings();
          }, 500));
        } else {
          // For other inputs, use input event with debounce
          element.addEventListener('input', debounce(() => {
            this.saveSettings();
          }, 1000)); // Wait 1 second after user stops typing
        }
      }
    });

    // Explicit save button
    document.getElementById('save-settings-btn')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('reset-settings-btn')?.addEventListener('click', () => this.resetSettings());
  }

  // Dashboard stats with real data and weekly activity
  async loadDashboardStats() {
    try {
      // Load articles count and recent articles
      const articlesResult = await apiClient.getArticles();
      let articlesData = [];
      if (articlesResult.success) {
        const totalArticles = document.getElementById('total-articles');
        if (totalArticles) totalArticles.textContent = articlesResult.data.length;
        articlesData = articlesResult.data;
      } else {
        console.error('Error loading articles count:', articlesResult.error);
      }

      // Load servers count
      try {
        const serversResult = await apiClient.makeAuthenticatedRequest('/api/servers');
        if (serversResult.success) {
          const totalServers = document.getElementById('total-servers');
          if (totalServers) totalServers.textContent = serversResult.data.length;
        } else {
          console.error('Error loading servers count:', serversResult.error);
        }
      } catch (error) {
        console.error('Error loading servers count:', error);
      }

      // Load messages count
      const messagesResult = await apiClient.getMessages();
      if (messagesResult.success) {
        const totalMessages = document.getElementById('total-messages');
        if (totalMessages) totalMessages.textContent = messagesResult.data.length;
      } else {
        console.error('Error loading messages count:', messagesResult.error);
      }

      // Load categories count
      const categoriesResult = await apiClient.getCategories();
      if (categoriesResult.success) {
        const totalCategories = document.getElementById('total-categories');
        if (totalCategories) totalCategories.textContent = categoriesResult.data.length;
      } else {
        console.error('Error loading categories count:', categoriesResult.error);
      }

      // Load activity list with recent items
      await this.loadActivityList(articlesData);

      // Initialize charts with real data
      this.initDashboardChartsWithData(articlesData);
    } catch (error) {
      console.error('Unexpected error loading dashboard stats:', error);
    }
  }

  // Load activity list with recent articles, servers, and messages
  async loadActivityList(articlesData) {
    const activityList = document.getElementById('activity-list');
    if (!activityList) return;

    activityList.innerHTML = '';

    try {
      // Get recent articles (last 5)
      const recentArticles = articlesData.slice(-5).reverse();
      
      // Get recent messages
      const messagesResult = await apiClient.getMessages();
      const recentMessages = messagesResult.success ? messagesResult.data.slice(-3).reverse() : [];

      // Combine and sort by date
      const activities = [];
      
      recentArticles.forEach(article => {
        activities.push({
          type: 'article',
          title: `Добавлена статья: ${article.title}`,
          description: article.excerpt || 'Новая статья опубликована',
          time: new Date(article.created_at),
          icon: '📝'
        });
      });

      recentMessages.forEach(message => {
        activities.push({
          type: 'message',
          title: `Новое сообщение от ${message.sender}`,
          description: message.content.substring(0, 100) + (message.content.length > 100 ? '...' : ''),
          time: new Date(message.created_at),
          icon: '💬'
        });
      });

      // Sort by time (newest first)
      activities.sort((a, b) => b.time - a.time);

      // Display activities (max 10)
      activities.slice(0, 10).forEach(activity => {
        const item = document.createElement('li');
        item.className = 'activity-item';
        
        const timeAgo = this.getTimeAgo(activity.time);
        
        item.innerHTML = `
          <div class="activity-header">
            <span class="activity-title-text">${activity.icon} ${activity.title}</span>
            <span class="activity-time">${timeAgo}</span>
          </div>
          <div class="activity-description">${activity.description}</div>
        `;
        
        activityList.appendChild(item);
      });

      if (activities.length === 0) {
        activityList.innerHTML = '<li class="activity-item"><div class="activity-description">Нет недавней активности</div></li>';
      }
    } catch (error) {
      console.error('Error loading activity list:', error);
      activityList.innerHTML = '<li class="activity-item"><div class="activity-description">Ошибка загрузки активности</div></li>';
    }
  }

  // Helper function to format time ago
  getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    
    if (seconds < 60) return 'Только что';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} дн. назад`;
    
    return date.toLocaleDateString('ru-RU');
  }

  // Initialize dashboard charts with real data
  initDashboardChartsWithData(articlesData) {
    // Check if Chart.js is available
    if (typeof Chart !== 'undefined') {
      const ctx = document.getElementById('weeklyActivityChart');
      if (ctx) {
        // Destroy existing chart if it exists
        if (ctx.chartInstance) {
          ctx.chartInstance.destroy();
        }

        // Calculate weekly activity from real articles data
        const weeklyData = this.calculateWeeklyActivity(articlesData);

        const chartData = {
          labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
          datasets: [{
            label: 'Статей за неделю',
            data: weeklyData,
            borderColor: 'rgb(86, 101, 242)',
            backgroundColor: 'rgba(86, 101, 242, 0.2)',
            tension: 0.1
          }]
        };

        const config = {
          type: 'line',
          data: chartData,
          options: {
            responsive: true,
            plugins: {
              legend: {
                position: 'top',
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  stepSize: 1
                }
              }
            }
          }
        };

        ctx.chartInstance = new Chart(ctx, config);
      }
    }
  }

  // Calculate weekly activity from articles data
  calculateWeeklyActivity(articlesData) {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Adjust for Monday start
    
    // Get Monday of current week
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayOffset);
    monday.setHours(0, 0, 0, 0);

    // Initialize array for 7 days
    const dailyCounts = [0, 0, 0, 0, 0, 0, 0];

    // Count articles per day
    articlesData.forEach(article => {
      const articleDate = new Date(article.created_at);
      if (articleDate >= monday) {
        const dayIndex = Math.floor((articleDate - monday) / (1000 * 60 * 60 * 24));
        if (dayIndex >= 0 && dayIndex < 7) {
          dailyCounts[dayIndex]++;
        }
      }
    });

    return dailyCounts;
  }

  // Метод для получения тегов из формы
  getTagsFromForm() {
    // Получаем теги из контейнера тегов
    const tagsContainer = document.getElementById('tagsContainer');
    if (!tagsContainer) return [];

    // Возвращаем массив тегов
    const tagElements = tagsContainer.querySelectorAll('.tag-item');
    const tags = [];

    tagElements.forEach(tagElement => {
      // Получаем текст тега, убирая символ удаления (×)
      const tagText = tagElement.textContent.replace(/\s*×\s*$/, '').trim();
      if (tagText) {
        tags.push(tagText);
      }
    });

    return tags;
  }

  // Load tags to the form when editing an article
  loadTagsToForm(tags) {
    const tagsContainer = document.getElementById('tagsContainer');
    if (!tagsContainer) return;

    // Clear existing tags
    tagsContainer.innerHTML = '';

    if (Array.isArray(tags) && tags.length > 0) {
      tagsContainer.style.display = 'flex';
      tagsContainer.style.flexWrap = 'wrap';
      tagsContainer.style.gap = '4px';
      tagsContainer.style.marginTop = '4px';

      tags.forEach(tag => {
        const tagElement = document.createElement('span');
        tagElement.className = 'tag-item';
        tagElement.style = `
          background: var(--blurple);
          color: white;
          padding: 2px 6px;
          border-radius: 10px;
          font-size: 12px;
          display: inline-flex;
          align-items: center;
          gap: 3px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.2);
        `;
        tagElement.innerHTML = `
          ${tag}
          <span class="tag-remove" style="cursor: pointer; margin-left: 4px; font-weight: bold; opacity: 0.8;">×</span>
        `;

        // Add event listener to the remove button
        const removeBtn = tagElement.querySelector('.tag-remove');
        removeBtn.onclick = (e) => {
          e.stopPropagation(); // Prevent event bubbling
          tagElement.remove(); // Remove the tag element

          // Hide the container if no tags remain
          if (tagsContainer.children.length === 0) {
            tagsContainer.style.display = 'none';
          }
        };

        tagsContainer.appendChild(tagElement);
      });
    } else {
      tagsContainer.style.display = 'none';
    }
  }
}

// Global router instance
let spaRouter = null;

// Initialize router after DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  // Create router instance only if authenticated
  if (authManager && authManager.isAuthenticated()) {
    spaRouter = new SPARouter();
  } else {
    // If not authenticated, show login form
    showModalLogin();
  }
});

// Check on auth status change
let authChangeInProgress = false;

window.addEventListener('authChanged', async () => {
  if (authChangeInProgress) return; // Prevent circular calls
  authChangeInProgress = true;

  try {
    // Small delay for full status change
    await new Promise(resolve => setTimeout(resolve, 100));

    if (authManager && authManager.isAuthenticated() && !spaRouter) {
      // If user logged in and router not created yet
      spaRouter = new SPARouter();
    } else if (authManager && !authManager.isAuthenticated() && spaRouter) {
      // If user logged out, remove router
      spaRouter = null;
      // Show login form
      showModalLogin();
    }
  } finally {
    authChangeInProgress = false;
  }
});

// Debounce function for auto-saving settings
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Export methods for global use
window.spaRouter = {
  navigateTo: (path) => {
    if (spaRouter) {
      spaRouter.navigateTo(path);
    }
  },

  loadArticlesList: async () => {
    if (spaRouter) {
      await spaRouter.loadArticlesList();
    }
  },

  createCategory: async () => {
    if (spaRouter) {
      await spaRouter.createCategory();
    }
  },

  createCategoryFromArticles: async () => {
    if (spaRouter) {
      await spaRouter.createCategoryFromArticles();
    }
  },

  deleteCategory: async (id, name) => {
    if (spaRouter) {
      await spaRouter.deleteCategory(id, name);
    }
  },

  saveArticle: () => {
    if (spaRouter) {
      spaRouter.saveArticle();
    }
  },

  addTag: () => {
    if (spaRouter) {
      spaRouter.addTag();
    }
  },

  removeTag: (tagText) => {
    if (spaRouter) {
      spaRouter.removeTag(tagText);
    }
  },

  previewArticle: () => {
    if (spaRouter) {
      spaRouter.previewArticle();
    }
  },

  closePreview: () => {
    if (spaRouter) {
      spaRouter.closePreview();
    }
  },

  clearArticleForm: () => {
    if (spaRouter) {
      spaRouter.clearArticleForm();
    }
  },

  uploadImage: async () => {
    if (spaRouter) {
      await spaRouter.uploadImage();
    }
  },

  selectCoverFromFile: () => {
    if (spaRouter) {
      spaRouter.selectCoverFromFile();
    }
  },

  handleCoverFileSelect: (inputElement) => {
    if (spaRouter) {
      spaRouter.handleCoverFileSelect(inputElement);
    }
  },

  selectCoverFromUrl: () => {
    if (spaRouter) {
      spaRouter.selectCoverFromUrl();
    }
  },

  removeArticleCover: () => {
    if (spaRouter) {
      spaRouter.removeArticleCover();
    }
  },

  searchArticles: async () => {
    if (spaRouter) {
      await spaRouter.searchArticles();
    }
  },

  editArticle: async (articleId) => {
    if (spaRouter) {
      await spaRouter.editArticle(articleId);
    }
  },

  deleteArticle: async (articleId) => {
    if (spaRouter) {
      await spaRouter.deleteArticle(articleId);
    }
  }
};