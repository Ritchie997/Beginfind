// auth-system.js - Система аутентификации BeginFind Admin Panel

class AuthManager {
  constructor() {
    this.token = null;
    this.user = null;
    this.tokenKey = 'beginfind_auth_token';
    this.userKey = 'beginfind_user_info';
    this.init();
  }

  init() {
    this.loadToken();
    this.loadUser();
    setInterval(() => { this.validateToken(); }, 5 * 60 * 1000);

    if (this.isAuthenticated()) {
      this.refreshProfile();
    }
  }

  async refreshProfile() {
    try {
      const response = await fetch('/api/profile', {
        headers: { 'Authorization': `Bearer ${this.getToken()}` }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.user) {
          this.setUser(data.user);
          if (typeof window.updateUserInfo === 'function') window.updateUserInfo();
        }
      }
    } catch (error) {
      console.error('Error refreshing profile:', error);
    }
  }

  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem(this.tokenKey, token);
      this.setAuthHeader(token);
    } else {
      localStorage.removeItem(this.tokenKey);
      this.removeAuthHeader();
    }
    this.dispatchAuthEvent('token_set');
  }

  getToken() {
    return this.token || localStorage.getItem(this.tokenKey) || null;
  }

  loadToken() {
    const token = localStorage.getItem(this.tokenKey);
    if (token) { this.token = token; this.setAuthHeader(token); }
  }

  setUser(user) {
    this.user = user;
    if (user) {
      localStorage.setItem(this.userKey, JSON.stringify(user));
    } else {
      localStorage.removeItem(this.userKey);
    }
  }

  getUser() {
    if (this.user) return this.user;
    const userStr = localStorage.getItem(this.userKey);
    if (userStr) {
      try { this.user = JSON.parse(userStr); return this.user; } catch (e) { return null; }
    }
    return null;
  }

  loadUser() {
    const userStr = localStorage.getItem(this.userKey);
    if (userStr) { try { this.user = JSON.parse(userStr); } catch (e) { this.user = null; } }
  }

  setAuthHeader(token) {
    if (!window.originalFetch) {
      window.originalFetch = window.fetch;
      window.fetch = (url, options = {}) => {
        const hasAuth = options.headers && (options.headers.Authorization || options.headers.authorization);
        if (!hasAuth && token) {
          if (!options.headers) options.headers = {};
          options.headers.Authorization = `Bearer ${token}`;
        }
        return window.originalFetch(url, options);
      };
    }
  }

  removeAuthHeader() {
    if (window.originalFetch) {
      window.fetch = window.originalFetch;
      window.originalFetch = null;
    }
  }

  isAuthenticated() {
    const token = this.getToken();
    if (!token) return false;
    try {
      const payload = this.decodeTokenPayload(token);
      if (payload && payload.exp) return payload.exp > Math.floor(Date.now() / 1000);
      return true;
    } catch (e) { return false; }
  }

  decodeTokenPayload(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  }

  async validateToken() {
    if (!this.isAuthenticated()) { this.logout(); return false; }
    try {
      const response = await fetch('/api/profile', {
        headers: { 'Authorization': `Bearer ${this.getToken()}` }
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { this.logout(); return false; }
      }
      const data = await response.json();
      if (data.user) this.setUser(data.user);
      return true;
    } catch (error) { return false; }
  }

  async login(username, password) {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (response.ok && data.token) {
        this.setToken(data.token);
        this.setUser(data.user);
        this.dispatchAuthEvent('login', { user: data.user });
        return { success: true, message: data.message };
      } else {
        return { success: false, error: data.error, status: data.status };
      }
    } catch (error) {
      return { success: false, error: 'Ошибка сети' };
    }
  }

  logout() {
    this.setToken(null);
    this.setUser(null);
    this.dispatchAuthEvent('logout');
  }

  async register(displayName, password, passwordConfirm, username) {
    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          password: password,
          password_confirm: passwordConfirm,
          username: username || displayName
        })
      });
      const data = await response.json();
      if (response.ok) {
        this.dispatchAuthEvent('register', { user: data.user });
        return { success: true, message: data.message, user: data.user };
      } else {
        return { success: false, error: data.error };
      }
    } catch (error) {
      return { success: false, error: 'Ошибка сети' };
    }
  }

  dispatchAuthEvent(eventType, data = {}) {
    window.dispatchEvent(new CustomEvent('authChanged', {
      detail: { type: eventType, ...data }
    }));
  }

  getCurrentUser() {
    return this.isAuthenticated() ? this.getUser() : null;
  }
}

const authManager = new AuthManager();

// ========================================
// МОДАЛЬНОЕ ОКНО АВТОРИЗАЦИИ / РЕГИСТРАЦИИ
// ========================================

function showModalLogin() {
  if (document.getElementById('auth-modal')) return;

  const modal = document.createElement('div');
  modal.id = 'auth-modal';
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.85); display: flex; align-items: center;
    justify-content: center; z-index: 10000; backdrop-filter: blur(8px);
    user-select: none;
  `;

  modal.innerHTML = `
    <div style="
      background: var(--background-secondary, #2f3136); padding: 30px;
      border-radius: 8px; width: 90%; max-width: 420px;
      box-shadow: 0 10px 20px rgba(0,0,0,0.3);
      border: 1px solid var(--background-accent, #4f545c);
      user-select: auto;
    ">
      <!-- Вкладки -->
      <div style="display: flex; gap: 0; margin-bottom: 24px; border-bottom: 2px solid var(--background-accent, #4f545c);">
        <button id="tab-login" type="button" style="
          flex: 1; padding: 10px; background: transparent; border: none;
          color: var(--text-normal, #dcddde); font-size: 15px; font-weight: 600;
          cursor: pointer; border-bottom: 2px solid #5865f2; margin-bottom: -2px;
        ">Вход</button>
        <button id="tab-register" type="button" style="
          flex: 1; padding: 10px; background: transparent; border: none;
          color: var(--text-muted, #b9bbbe); font-size: 15px; font-weight: 600;
          cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px;
        ">Регистрация</button>
      </div>

      <!-- Форма входа -->
      <form id="auth-form" style="display: flex; flex-direction: column;">
        <div style="margin-bottom: 15px;">
          <label for="auth-username" style="display:block; margin-bottom:8px; color:var(--text-muted, #b9bbbe); font-weight:500;">Имя пользователя:</label>
          <input type="text" id="auth-username" autocomplete="username" required style="
            width:100%; padding:12px; box-sizing:border-box;
            background:var(--background-tertiary, #36393f); border:1px solid var(--background-accent, #4f545c);
            border-radius:4px; color:var(--text-normal, #dcddde); font-size:15px;
          ">
        </div>
        <div style="margin-bottom: 20px;">
          <label for="auth-password" style="display:block; margin-bottom:8px; color:var(--text-muted, #b9bbbe); font-weight:500;">Пароль:</label>
          <input type="password" id="auth-password" autocomplete="current-password" required style="
            width:100%; padding:12px; box-sizing:border-box;
            background:var(--background-tertiary, #36393f); border:1px solid var(--background-accent, #4f545c);
            border-radius:4px; color:var(--text-normal, #dcddde); font-size:15px;
          ">
        </div>
        <div id="auth-message" style="display:none; margin-bottom:12px; padding:10px; border-radius:4px; font-size:14px;"></div>
        <button type="submit" id="auth-submit" style="
          background:#5865f2; color:white; padding:12px; border:none; border-radius:4px;
          cursor:pointer; font-size:15px; font-weight:500; transition:background-color 0.2s;
        ">Войти</button>
      </form>

      <!-- Форма регистрации (скрыта по умолчанию) -->
      <form id="register-form" style="display:none; flex-direction:column;">
        <div style="margin-bottom: 15px;">
          <label for="reg-displayname" style="display:block; margin-bottom:8px; color:var(--text-muted, #b9bbbe); font-weight:500;">Имя:</label>
          <input type="text" id="reg-displayname" autocomplete="username" required style="
            width:100%; padding:12px; box-sizing:border-box;
            background:var(--background-tertiary, #36393f); border:1px solid var(--background-accent, #4f545c);
            border-radius:4px; color:var(--text-normal, #dcddde); font-size:15px;
          ">
        </div>
        <div style="margin-bottom: 15px;">
          <label for="reg-password" style="display:block; margin-bottom:8px; color:var(--text-muted, #b9bbbe); font-weight:500;">Пароль:</label>
          <input type="password" id="reg-password" autocomplete="new-password" required minlength="6" style="
            width:100%; padding:12px; box-sizing:border-box;
            background:var(--background-tertiary, #36393f); border:1px solid var(--background-accent, #4f545c);
            border-radius:4px; color:var(--text-normal, #dcddde); font-size:15px;
          ">
        </div>
        <div style="margin-bottom: 20px;">
          <label for="reg-password-confirm" style="display:block; margin-bottom:8px; color:var(--text-muted, #b9bbbe); font-weight:500;">Повтор пароля:</label>
          <input type="password" id="reg-password-confirm" autocomplete="new-password" required minlength="6" style="
            width:100%; padding:12px; box-sizing:border-box;
            background:var(--background-tertiary, #36393f); border:1px solid var(--background-accent, #4f545c);
            border-radius:4px; color:var(--text-normal, #dcddde); font-size:15px;
          ">
        </div>
        <div id="reg-message" style="display:none; margin-bottom:12px; padding:10px; border-radius:4px; font-size:14px;"></div>
        <button type="submit" id="reg-submit" style="
          background:#5865f2; color:white; padding:12px; border:none; border-radius:4px;
          cursor:pointer; font-size:15px; font-weight:500; transition:background-color 0.2s;
        ">Отправить заявку</button>
      </form>

      <!-- Статус после регистрации -->
      <div id="reg-pending" style="display:none; text-align:center; padding:20px 0;">
        <div style="font-size:40px; margin-bottom:12px;">⏳</div>
        <h3 style="color:var(--header-primary, #fff); margin-bottom:8px;">Заявка отправлена</h3>
        <p style="color:var(--text-muted, #b9bbbe); margin-bottom:20px; line-height:1.5;">Ваша заявка ожидает подтверждения администратором.<br>Вы получите доступ после одобрения.</p>
        <button id="reg-pending-back" type="button" style="
          background:#5865f2; color:white; padding:12px 24px; border:none; border-radius:4px;
          cursor:pointer; font-size:15px; font-weight:500;
        ">Вернуться ко входу</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Переключение вкладок
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const authForm = document.getElementById('auth-form');
  const registerForm = document.getElementById('register-form');
  const regPending = document.getElementById('reg-pending');

  function showTab(tab) {
    regPending.style.display = 'none';
    if (tab === 'login') {
      authForm.style.display = 'flex';
      registerForm.style.display = 'none';
      tabLogin.style.color = 'var(--text-normal, #dcddde)';
      tabLogin.style.borderBottomColor = '#5865f2';
      tabRegister.style.color = 'var(--text-muted, #b9bbbe)';
      tabRegister.style.borderBottomColor = 'transparent';
    } else {
      authForm.style.display = 'none';
      registerForm.style.display = 'flex';
      tabRegister.style.color = 'var(--text-normal, #dcddde)';
      tabRegister.style.borderBottomColor = '#5865f2';
      tabLogin.style.color = 'var(--text-muted, #b9bbbe)';
      tabLogin.style.borderBottomColor = 'transparent';
    }
  }

  tabLogin.addEventListener('click', () => showTab('login'));
  tabRegister.addEventListener('click', () => showTab('register'));

  // ВХОД
  const loginForm = document.getElementById('auth-form');
  const loginSubmit = document.getElementById('auth-submit');
  const loginUsername = document.getElementById('auth-username');
  const loginPassword = document.getElementById('auth-password');
  const authMessage = document.getElementById('auth-message');
  let isSubmitting = false;

  function showFieldMessage(element, text, type) {
    element.style.display = 'block';
    element.textContent = text;
    element.style.background = type === 'error' ? 'rgba(220,53,69,0.15)' : 'rgba(40,167,69,0.15)';
    element.style.color = type === 'error' ? '#f87171' : '#4ade80';
    element.style.border = `1px solid ${type === 'error' ? 'rgba(220,53,69,0.3)' : 'rgba(40,167,69,0.3)'}`;
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    loginSubmit.disabled = true;
    loginSubmit.textContent = 'Вход...';
    authMessage.style.display = 'none';

    try {
      const result = await authManager.login(loginUsername.value, loginPassword.value);
      if (result.success) {
        modal.remove();
        showMessageOnPage(result.message, 'success');
        if (typeof updateUserInfo === 'function') updateUserInfo();
        if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
          setTimeout(() => { window.location.reload(); }, 800);
        }
      } else {
        showFieldMessage(authMessage, result.error || 'Ошибка входа', 'error');
      }
    } catch (error) {
      showFieldMessage(authMessage, 'Ошибка при попытке входа', 'error');
    } finally {
      isSubmitting = false;
      loginSubmit.disabled = false;
      loginSubmit.textContent = 'Войти';
    }
  });

  // РЕГИСТРАЦИЯ
  const regForm = document.getElementById('register-form');
  const regSubmit = document.getElementById('reg-submit');
  const regDisplayname = document.getElementById('reg-displayname');
  const regPassword = document.getElementById('reg-password');
  const regPasswordConfirm = document.getElementById('reg-password-confirm');
  const regMessage = document.getElementById('reg-message');

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (regPassword.value !== regPasswordConfirm.value) {
      showFieldMessage(regMessage, 'Пароли не совпадают', 'error');
      return;
    }

    isSubmitting = true;
    regSubmit.disabled = true;
    regSubmit.textContent = 'Отправка...';
    regMessage.style.display = 'none';

    try {
      const result = await authManager.register(
        regDisplayname.value,
        regPassword.value,
        regPasswordConfirm.value,
        regDisplayname.value
      );

      if (result.success) {
        regForm.style.display = 'none';
        regPending.style.display = 'block';
      } else {
        showFieldMessage(regMessage, result.error || 'Ошибка регистрации', 'error');
      }
    } catch (error) {
      showFieldMessage(regMessage, 'Ошибка при отправке заявки', 'error');
    } finally {
      isSubmitting = false;
      regSubmit.disabled = false;
      regSubmit.textContent = 'Отправить заявку';
    }
  });

  document.getElementById('reg-pending-back').addEventListener('click', () => {
    showTab('login');
  });

  // Нет кнопки закрытия — модалка остаётся пока пользователь не войдёт
}

// Показ сообщения на основной странице
function showMessageOnPage(text, type = 'info') {
  const existing = document.getElementById('message-container');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'message-container';
  container.style.cssText = `
    position: fixed; top: 20px; right: 20px; padding: 15px 20px;
    border-radius: 4px; color: white; z-index: 10001;
    background: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff'};
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  container.textContent = text;
  document.body.appendChild(container);
  setTimeout(() => { if (container.parentNode) container.remove(); }, 5000);
}

function checkAuthStatus() {
  if (!authManager.isAuthenticated()) {
    showModalLogin();
  }
}

// Блокировка для pending/rejected пользователей
function showStatusBlocker(status, reason) {
  if (status === 'approved') return;

  const blocker = document.createElement('div');
  blocker.id = 'status-blocker';
  blocker.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.85); display: flex; align-items: center;
    justify-content: center; z-index: 9999; backdrop-filter: blur(8px);
  `;

  const icon = status === 'pending' ? '⏳' : '❌';
  const title = status === 'pending' ? 'Аккаунт ожидает подтверждения' : 'Доступ отклонён';
  const message = status === 'pending'
    ? 'Ваша заявка ещё не одобрена администратором.<br>Пожалуйста, обратитесь к root-пользователю.'
    : `Причина: ${reason || 'Заявка отклонена администратором.'}<br>Обратитесь к root-пользователю.`;

  blocker.innerHTML = `
    <div style="
      background: var(--background-secondary, #2f3136); padding: 40px; border-radius: 12px;
      width: 90%; max-width: 480px; text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4); border: 1px solid var(--background-accent, #4f545c);
    ">
      <div style="font-size:56px; margin-bottom:16px;">${icon}</div>
      <h2 style="color:var(--header-primary, #fff); margin-bottom:12px;">${title}</h2>
      <p style="color:var(--text-muted, #b9bbbe); margin-bottom:24px; line-height:1.6;">${message}</p>
      <button id="status-blocker-logout" style="
        background: #dc3545; color: white; padding: 12px 32px; border: none;
        border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: 500;
      ">Выйти</button>
    </div>
  `;

  document.body.appendChild(blocker);
  document.getElementById('status-blocker-logout').addEventListener('click', () => {
    authManager.logout();
    blocker.remove();
    showModalLogin();
  });
}

// Экспорт
window.authManager = authManager;
window.showModalLogin = showModalLogin;
window.showMessageOnPage = showMessageOnPage;
window.checkAuthStatus = checkAuthStatus;
window.showStatusBlocker = showStatusBlocker;
