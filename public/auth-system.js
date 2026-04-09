// auth-system.js - Надежная система аутентификации для BeginFind Admin Panel

class AuthManager {
  constructor() {
    this.token = null;
    this.user = null;
    this.tokenKey = 'beginfind_auth_token';
    this.userKey = 'beginfind_user_info';
    this.init();
  }

  // Инициализация системы аутентификации
  init() {
    // Загружаем токен и информацию о пользователе из localStorage при инициализации
    this.loadToken();
    this.loadUser();
    
    // Регулярная проверка валидности токена (раз в 5 минут)
    setInterval(() => {
      this.validateToken();
    }, 5 * 60 * 1000); // 5 минут
  }

  // Сохранение токена в localStorage и в память
  setToken(token) {
    this.token = token;
    
    if (token) {
      localStorage.setItem(this.tokenKey, token);
      // Устанавливаем заголовки для всех будущих fetch-запросов
      this.setAuthHeader(token);
    } else {
      localStorage.removeItem(this.tokenKey);
      this.removeAuthHeader();
    }
    
    // Вызываем событие изменения аутентификации
    this.dispatchAuthEvent('token_set');
  }

  // Получение токена
  getToken() {
    return this.token || localStorage.getItem(this.tokenKey) || null;
  }

  // Загрузка токена из localStorage
  loadToken() {
    const token = localStorage.getItem(this.tokenKey);
    if (token) {
      this.token = token;
      this.setAuthHeader(token);
    }
  }

  // Сохранение информации о пользователе
  setUser(user) {
    this.user = user;
    
    if (user) {
      localStorage.setItem(this.userKey, JSON.stringify(user));
    } else {
      localStorage.removeItem(this.userKey);
    }
  }

  // Получение информации о пользователе
  getUser() {
    if (this.user) {
      return this.user;
    }
    
    const userStr = localStorage.getItem(this.userKey);
    if (userStr) {
      try {
        this.user = JSON.parse(userStr);
        return this.user;
      } catch (e) {
        console.error('Error parsing user info:', e);
        return null;
      }
    }
    return null;
  }

  // Загрузка информации о пользователе из localStorage
  loadUser() {
    const userStr = localStorage.getItem(this.userKey);
    if (userStr) {
      try {
        this.user = JSON.parse(userStr);
      } catch (e) {
        console.error('Error loading user info:', e);
        this.user = null;
      }
    }
  }

  // Установка заголовков аутентификации для fetch-запросов
  setAuthHeader(token) {
    // Создаем обертку для fetch, чтобы автоматически добавлять токен
    if (!window.originalFetch) {
      window.originalFetch = window.fetch;
      
      window.fetch = (url, options = {}) => {
        const hasAuth = options.headers && (options.headers.Authorization || options.headers.authorization);
        
        if (!hasAuth && token) {
          if (!options.headers) {
            options.headers = {};
          }
          options.headers.Authorization = `Bearer ${token}`;
        }
        
        return window.originalFetch(url, options);
      };
    }
  }

  // Удаление заголовков аутентификации
  removeAuthHeader() {
    if (window.originalFetch) {
      window.fetch = window.originalFetch;
      window.originalFetch = null;
    }
  }

  // Проверка аутентификации
  isAuthenticated() {
    const token = this.getToken();
    if (!token) {
      return false;
    }

    // Проверяем, не истек ли токен
    try {
      const payload = this.decodeTokenPayload(token);
      if (payload && payload.exp) {
        const currentTime = Math.floor(Date.now() / 1000);
        return payload.exp > currentTime;
      }
      return true;
    } catch (e) {
      console.error('Error validating token:', e);
      return false;
    }
  }

  // Декодирование payload из JWT токена
  decodeTokenPayload(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token format');
      }

      const payload = parts[1];
      // Декодируем base64
      const decodedPayload = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decodedPayload);
    } catch (e) {
      console.error('Error decoding token:', e);
      throw e;
    }
  }

  // Проверка валидности токена с сервера
  async validateToken() {
    if (!this.isAuthenticated()) {
      this.logout();
      return false;
    }

    try {
      const response = await fetch('/api/profile', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.getToken()}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.logout();
          return false;
        }
      }

      const data = await response.json();
      // Обновляем информацию о пользователе, если получили новую
      if (data.user) {
        this.setUser(data.user);
      }

      return true;
    } catch (error) {
      console.error('Error validating token:', error);
      return false;
    }
  }

  // Логин
  async login(username, password) {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (response.ok && data.token) {
        // Устанавливаем токен и информацию о пользователе
        this.setToken(data.token);
        this.setUser(data.user || { username: username });
        
        // Вызываем событие успешного логина
        this.dispatchAuthEvent('login', { user: data.user || { username: username } });
        
        return { success: true, message: data.message || 'Login successful' };
      } else {
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch (error) {
      console.error('Login error:', error);
      return { success: false, error: 'Network error occurred' };
    }
  }

  // Логаут
  logout() {
    this.setToken(null);
    this.setUser(null);
    
    // Вызываем событие логаута
    this.dispatchAuthEvent('logout');
  }

  // Регистрация
  async register(username, password, confirmPassword) {
    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password, confirmPassword })
      });

      const data = await response.json();

      if (response.ok) {
        // Сохраняем информацию о pending регистрации
        localStorage.setItem(this.pendingRegistrationKey, JSON.stringify({
          username,
          timestamp: Date.now()
        }));
        
        // Вызываем событие успешной регистрации
        this.dispatchAuthEvent('register', { user: data.user });
        
        return { success: true, message: data.message || 'Заявка отправлена', user: data.user };
      } else {
        return { success: false, error: data.error || 'Registration failed' };
      }
    } catch (error) {
      console.error('Registration error:', error);
      return { success: false, error: 'Network error occurred' };
    }
  }
  
  // Проверка наличия pending регистрации
  hasPendingRegistration() {
    const pending = localStorage.getItem(this.pendingRegistrationKey);
    if (pending) {
      try {
        return JSON.parse(pending);
      } catch (e) {
        return null;
      }
    }
    return null;
  }
  
  // Очистка pending регистрации
  clearPendingRegistration() {
    localStorage.removeItem(this.pendingRegistrationKey);
  }

  // Вызов события аутентификации
  dispatchAuthEvent(eventType, data = {}) {
    const event = new CustomEvent('authChanged', {
      detail: {
        type: eventType,
        ...data
      }
    });
    window.dispatchEvent(event);
  }

  // Получение информации о текущем пользователе
  getCurrentUser() {
    if (!this.isAuthenticated()) {
      return null;
    }
    return this.getUser();
  }
  
  // Проверка, является ли пользователь root
  isRoot() {
    const user = this.getUser();
    return user && user.is_root === 1;
  }
}

// Создаем глобальный экземпляр AuthManager
const authManager = new AuthManager();

// Функция для показа модального окна логина
function showModalLogin() {
  // Проверяем, не открыто ли уже модальное окно
  if (document.getElementById('auth-modal')) {
    return;
  }

  // Создаем модальное окно
  const modal = document.createElement('div');
  modal.id = 'auth-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    backdrop-filter: blur(5px);
  `;

  modal.innerHTML = `
    <div style="
      background: var(--background-secondary, #2f3136);
      padding: 30px;
      border-radius: 8px;
      width: 90%;
      max-width: 400px;
      box-shadow: 0 10px 20px rgba(0,0,0,0.3);
      border: 1px solid var(--background-accent, #4f545c);
    ">
      <h3 style="
        margin-top: 0;
        margin-bottom: 20px;
        color: var(--header-primary, #fff);
        text-align: center;
        font-size: 22px;
      ">Вход в систему</h3>
      <form id="auth-form" style="display: flex; flex-direction: column;">
        <div style="margin-bottom: 15px;">
          <label for="auth-username" style="
            display: block;
            margin-bottom: 8px;
            color: var(--text-muted, #b9bbbe);
            font-weight: 500;
          ">Имя пользователя:</label>
          <input type="text" id="auth-username" required style="
            width: 100%;
            padding: 12px;
            box-sizing: border-box;
            background-color: var(--background-tertiary, #36393f);
            border: 1px solid var(--background-accent, #4f545c);
            border-radius: 4px;
            color: var(--text-normal, #dcddde);
            font-size: 16px;
          ">
        </div>
        <div style="margin-bottom: 20px;">
          <label for="auth-password" style="
            display: block;
            margin-bottom: 8px;
            color: var(--text-muted, #b9bbbe);
            font-weight: 500;
          ">Пароль:</label>
          <input type="password" id="auth-password" required style="
            width: 100%;
            padding: 12px;
            box-sizing: border-box;
            background-color: var(--background-tertiary, #36393f);
            border: 1px solid var(--background-accent, #4f545c);
            border-radius: 4px;
            color: var(--text-normal, #dcddde);
            font-size: 16px;
          ">
        </div>
        <button type="submit" id="auth-submit" style="
          background: #5865f2;
          color: white;
          padding: 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 16px;
          font-weight: 500;
          transition: background-color 0.2s ease;
          margin-bottom: 10px;
        ">Войти</button>
        <button type="button" id="auth-close" style="
          background: var(--background-accent, #4f545c);
          color: var(--text-normal, #dcddde);
          padding: 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 16px;
          font-weight: 500;
          transition: background-color 0.2s ease;
        ">Закрыть</button>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  // Обработчики формы
  const form = document.getElementById('auth-form');
  const submitBtn = document.getElementById('auth-submit');
  const closeBtn = document.getElementById('auth-close');
  const usernameInput = document.getElementById('auth-username');
  const passwordInput = document.getElementById('auth-password');
  
  let isSubmitting = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (isSubmitting) return;
    
    isSubmitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Вход...';
    
    try {
      const result = await authManager.login(usernameInput.value, passwordInput.value);
      
      if (result.success) {
        // Закрываем модальное окно
        modal.remove();
        
        // Показываем сообщение об успехе
        showMessage(result.message, 'success');
        
        // Обновляем UI с информацией о пользователе
        if (typeof updateUserInfo === 'function') {
          updateUserInfo();
        }
        
        // Скрываем оверлей авторизации если он есть
        const authOverlay = document.getElementById('auth-overlay');
        if (authOverlay) {
          authOverlay.classList.add('hidden');
        }
        
        // Показываем основной контейнер приложения
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
          appContainer.classList.add('loaded');
        }
        
        // Инициализируем роутер если он еще не создан
        if (typeof window.SPARouter !== 'undefined' && !window.spaRouter) {
          window.spaRouter = new window.SPARouter();
        } else if (window.spaRouter && typeof window.spaRouter.navigateTo === 'function') {
          // Если роутер уже существует, перенаправляем на дашборд
          window.spaRouter.navigateTo('/dashboard');
        } else {
          // Фолбэк: простая переадресация через history.pushState
          setTimeout(() => {
            window.history.pushState({ path: '/dashboard' }, '', '/dashboard');
            window.dispatchEvent(new PopStateEvent('popstate'));
          }, 500);
        }
      } else {
        showMessage(result.error, 'error');
      }
    } catch (error) {
      showMessage('Ошибка при попытке входа', 'error');
    } finally {
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Войти';
    }
  });

  closeBtn.addEventListener('click', () => {
    modal.remove();
  });

  // Закрытие по клику вне формы
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

// Функция для показа сообщений
function showMessage(text, type = 'info') {
  // Удаляем предыдущие сообщения
  const existingMessage = document.getElementById('message-container');
  if (existingMessage) {
    existingMessage.remove();
  }
  
  // Создаем контейнер для сообщения
  const messageContainer = document.createElement('div');
  messageContainer.id = 'message-container';
  messageContainer.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 20px;
    border-radius: 4px;
    color: white;
    z-index: 10001;
    ${type === 'error' ? 'background: #dc3545;' : 
      type === 'success' ? 'background: #28a745;' : 
      'background: #007bff;'}
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  `;
  messageContainer.textContent = text;
  
  document.body.appendChild(messageContainer);
  
  // Удаляем сообщение через 5 секунд
  setTimeout(() => {
    if (messageContainer.parentNode) {
      messageContainer.remove();
    }
  }, 5000);
}

// Функция для проверки и обновления состояния аутентификации
function checkAuthStatus() {
  if (!authManager.isAuthenticated()) {
    showModalLogin();
  }
}

// Экспортируем необходимые функции в глобальную область
window.authManager = authManager;
window.showModalLogin = showModalLogin;
window.showMessage = showMessage;
window.checkAuthStatus = checkAuthStatus;