// auth.routes.js — регистрация, вход, профиль, управление заявками (root).

const express = require('express');
const auth = require('../middleware/auth');

const router = express.Router();

// POST /api/register — Регистрация (статус pending, без авто-логина)
router.post('/register', auth.rateLimitLimiter('registration'), async (req, res) => {
  try {
    const { display_name, password, username } = req.body;

    if (!display_name || !password) {
      return res.status(400).json({ error: 'Имя и пароль обязательны' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    if (password !== req.body.password_confirm) {
      return res.status(400).json({ error: 'Пароли не совпадают' });
    }

    console.log('Registration attempt for:', display_name);

    const user = await auth.register(display_name, password, username);

    console.log('Registration pending for user:', user.username);

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        status: user.status
      },
      message: 'Заявка отправлена. Ожидает подтверждения'
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/login — Вход
router.post('/login', auth.rateLimitLimiter('login'), async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
    }

    console.log('Login attempt for username:', username);

    const user = await auth.login(username, password);
    const token = await auth.generateToken(user);

    console.log('Login successful for user:', user.username);

    res.json({
      user,
      token,
      message: 'Вход выполнен успешно'
    });
  } catch (error) {
    console.error('Login error:', error.message);
    // Специфичная обработка для pending статуса
    if (error.message === 'Аккаунт ожидает подтверждения администратором') {
      return res.status(403).json({
        error: error.message,
        status: 'pending'
      });
    }
    // Специфичная обработка для rejected статуса
    if (error.message.startsWith('Доступ отклонён')) {
      return res.status(403).json({
        error: error.message,
        status: 'rejected'
      });
    }
    res.status(401).json({ error: error.message });
  }
});

// GET /api/profile — Профиль текущего пользователя
router.get('/profile', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const user = await auth.getUserById(req.user.id);
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/profile/observer-status — Статус "наблюдателя" для текущего пользователя.
// Раньше делал require('./server-membership-check') — файла, которого больше
// нет в репозитории (логика уже встроена в auth.js), маршрут падал с 500 при
// каждом обращении. Теперь использует auth.assignObserverRoleIfNeeded напрямую.
router.get('/profile/observer-status', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const observerCheck = await auth.assignObserverRoleIfNeeded(req.user.id);
    res.json(observerCheck);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// МАРШРУТЫ УПРАВЛЕНИЯ ЗАЯВКАМИ (root only)
// ========================================

// GET /api/pending-users — Список ожидающих подтверждения
router.get('/pending-users', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const pendingUsers = await auth.getPendingUsers();
    res.json({ users: pendingUsers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/pending-users/:id/approve — Одобрить пользователя
router.put('/pending-users/:id/approve', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await auth.approveUser(id, req.user.username);
    res.json({ message: 'Пользователь одобрен', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/pending-users/:id/reject — Отклонить пользователя
router.put('/pending-users/:id/reject', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await auth.rejectUser(id, reason, req.user.username);
    res.json({ message: 'Заявка отклонена', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/all-users — Все пользователи (root only)
router.get('/all-users', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const users = await auth.getAllUsers();
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
