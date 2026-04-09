const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const os = require('os');
require('dotenv').config();
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB лимит
  },
  fileFilter: function (req, file, cb) {
    // Проверяем, что файл является изображением
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения!'));
    }
  }
});

// Middleware для обработки кэширования JavaScript файлов
app.use(/\.js$/, (req, res, next) => {
  // Устанавливаем заголовки для предотвращения кэширования JS файлов
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Middleware для статических файлов
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// Обслуживание главной страницы
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Альтернативный маршрут для test.html
app.get('/test.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Добавляем маршруты для всех HTML файлов в папке public
app.get('/admin-panel.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/articles.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/categories.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/roles.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/settings.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Поддержка CORS для разных IP-адресов
const corsOptions = {
  origin: function (origin, callback) {
    // Разрешаем запросы без источника (например, мобильные приложения или curl)
    if (!origin) return callback(null, true);
    
    // Проверяем, является ли источник локальным или из локальной сети
    const allowedOrigins = [
      'http://localhost',
      'http://127.0.0.1',
      'http://0.0.0.0',
      /http:\/\/\d+\.\d+\.\d+\.\d+/,  // разрешаем IP-адреса через http
      /https?:\/\/.*duckdns\.org/        // разрешаем домены DuckDNS
    ];
    
    const isAllowed = allowedOrigins.some(pattern => {
      if (typeof pattern === 'string') {
        return origin === pattern || origin?.startsWith(pattern);
      } else if (pattern instanceof RegExp) {
        return pattern.test(origin);
      }
      return false;
    });
    
    callback(null, isAllowed);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};



// Middleware для API
app.use('/api/*', express.json({ limit: '10mb' }));
app.use('/api/*', express.urlencoded({ extended: true, limit: '10mb' }));

// Установка CORS заголовков для API
app.use('/api/*', cors(corsOptions));

// Маршруты аутентификации

// Rate limiting для регистрации и логина
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 минут
const RATE_LIMIT_MAX = 10; // максимум 10 попыток

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const record = rateLimitStore.get(ip);
  
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  if (record.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
  }
  
  record.count++;
  next();
}

app.post('/api/register', rateLimitMiddleware, async (req, res) => {
  try {
    const { username, password, confirmPassword } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
    }
    
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Пароли не совпадают' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    }
    
    console.log('Registration attempt for username:', username);
    
    const user = await auth.register(username, password);
    
    console.log('Registration successful for user:', user.username);
    
    // Не выдаем токен при регистрации со статусом pending
    res.json({ 
      user: { id: user.id, username: user.username, status: user.status },
      message: 'Заявка отправлена. Ожидает подтверждения'
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', rateLimitMiddleware, async (req, res) => {
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
    res.status(401).json({ error: error.message });
  }
});

app.get('/api/profile', auth.authenticateToken, async (req, res) => {
  try {
    const user = await auth.getUserById(req.user.id);
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для получения заявок на подтверждение (только для root)
app.get('/api/admin/pending-users', auth.authenticateToken, async (req, res) => {
  try {
    // Проверяем, является ли пользователь root
    const user = await auth.getUserById(req.user.id);
    
    if (!user.is_root) {
      return res.status(403).json({ error: 'Доступ запрещен. Требуются права root.' });
    }
    
    const pendingUsers = await auth.getPendingUsers();
    res.json({ users: pendingUsers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для подтверждения/отклонения заявок (только для root)
app.post('/api/admin/user-status', auth.authenticateToken, async (req, res) => {
  try {
    const { userId, status } = req.body;
    
    // Проверяем, является ли пользователь root
    const currentUser = await auth.getUserById(req.user.id);
    
    if (!currentUser.is_root) {
      return res.status(403).json({ error: 'Доступ запрещен. Требуются права root.' });
    }
    
    if (!userId || !status) {
      return res.status(400).json({ error: 'Необходимо указать userId и status' });
    }
    
    const result = await auth.updateUserStatus(userId, status);
    res.json({ success: true, user: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Создание подключения к базе данных для мессенджера
const messengerDb = new sqlite3.Database(path.join(__dirname, 'messenger.db'), (err) => {
  if (err) {
    console.error('Error opening messenger database', err);
  } else {
    console.log('Connected to messenger SQLite database');
    // Установка кодировки для корректной работы с кириллицей
    messengerDb.run("PRAGMA encoding = 'UTF-8'");
    // Создание таблиц, если они не существуют
    messengerDb.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Создание подключения к базе данных для статей
const articlesDb = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Error opening articles database', err);
  } else {
    console.log('Connected to articles SQLite database');
    // Установка кодировки для корректной работы с кириллицей
    articlesDb.run("PRAGMA encoding = 'UTF-8'");
  }
});

// Создание подключения к базе данных для серверов
const serversDb = new sqlite3.Database(path.join(__dirname, 'servers.db'), (err) => {
  if (err) {
    console.error('Error opening servers database', err);
  } else {
    console.log('Connected to servers SQLite database');
    // Установка кодировки для корректной работы с кириллицей
    serversDb.run("PRAGMA encoding = 'UTF-8'");
  }
});

// API маршруты для мессенджера
app.get('/api/messages', auth.authenticateToken, (req, res) => {
  messengerDb.all('SELECT * FROM messages ORDER BY timestamp DESC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // Преобразование кодировки для кириллических символов
    const encodedRows = rows.map(row => {
      return {
        ...row,
        sender: row.sender,
        content: row.content
      };
    });
    res.json(encodedRows);
  });
});

app.post('/api/messages', auth.authenticateToken, (req, res) => {
  const { sender, content } = req.body;
  messengerDb.run('INSERT INTO messages (sender, content) VALUES (?, ?)', [sender, content], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ id: this.lastID });
  });
});

        // Функция для получения имени сервера по ID
        function getServerNameById(serverId) {
          return new Promise((resolve, reject) => {
            // Используем объект базы данных серверов
            serversDb.get('SELECT name FROM servers WHERE id = ?', [serverId], (err, row) => {
              if (err) {
                console.error('Error getting server name by ID:', err);
                resolve(null); // Возвращаем null в случае ошибки
              } else if (row) {
                resolve(row.name); // Возвращаем имя сервера
              } else {
                resolve(null); // Сервер с таким ID не найден
              }
            });
          });
        }

        // Функция для обновления URL изображений в содержимом статьи
        function updateImageUrlsInContent(content, req = null) {
          if (!content) return content;
          
          // Обрабатываем все теги <img> с относительными URL на полные URL
          // Это выражение обрабатывает как самозакрывающиеся, так и обычные теги <img>
          return content.replace(/<img\s+([^>]*?)src=(["'])((?!https?:\/\/)[^"']*)(["'])([^>]*?)>/gi, (match, beforeSrc, quote1, src, quote2, afterTag) => {
            // Проверяем, заканчивается ли тег на "/>" (самозакрывающийся тег)
            const isSelfClosing = match.trim().endsWith('/>');
            
            const formattedUrl = formatImageUrl(src, req);
            const newTag = `<img ${beforeSrc}src=${quote1}${formattedUrl}${quote2}${afterTag}>`;
            
            // Если тег изначально был самозакрывающимся, сохраняем "/" перед ">"
            if (isSelfClosing) {
              return newTag.replace('>', '/>');
            }
            return newTag;
          });
        }

        // API маршруты для статей
        app.get('/api/articles', auth.authenticateToken, async (req, res) => {
          const { since, server: serverFilter } = req.query; // Добавляем возможность фильтрации по серверу
          
          let query = 'SELECT * FROM articles'; // Включаем content в выборку
          let params = [];
          
          // Добавляем условия фильтрации
          let whereConditions = [];
          if (since) {
            whereConditions.push('created_at > ?');
            params.push(since);
          }
          
          // Фильтруем по серверу, если указан параметр server
          if (serverFilter) {
            whereConditions.push('server = ?');
            params.push(serverFilter);
          }
          // Если параметр server не указан, возвращаем все статьи (без фильтрации по серверу)
          // Это позволяет отображать статьи с любыми значениями сервера
          
          if (whereConditions.length > 0) {
            query += ' WHERE ' + whereConditions.join(' AND ');
          }
          
          query += ' ORDER BY created_at DESC';
          
          articlesDb.all(query, params, async (err, rows) => {
            if (err) {
              res.status(500).json({ error: err.message });
              return;
            }
            // Преобразование кодировки для кириллических символов и парсинг JSON полей
            const encodedRows = [];
            for (const row of rows) {
              console.log('Original image path from DB:', row.image); // Отладка
              const formattedImage = formatImageUrl(row.image, req);
              console.log('Formatted image URL:', formattedImage); // Отладка
              
              // Проверяем, является ли значение server числовым ID
              let serverName = row.server;
              if (row.server && !isNaN(row.server) && parseInt(row.server) > 0) {
                // Это ID сервера, получаем его имя
                const serverFromDb = await getServerNameById(parseInt(row.server));
                if (serverFromDb) {
                  serverName = serverFromDb;
                }
              }
              
              encodedRows.push({
                ...row,
                title: row.title,
                content: updateImageUrlsInContent(row.content, req), // Обновляем URL изображений в содержимом
                views: row.views,
                locked: row.locked === 1,
                role: row.role,
                roles: row.role && row.role.startsWith('[') && row.role.endsWith(']') ? JSON.parse(row.role) : (row.role ? [row.role] : []),
                category: row.category,
                tags: row.tags ? JSON.parse(row.tags) : [],
                author: row.author,
                image: formattedImage,
                attachments: row.attachments ? JSON.parse(row.attachments) : [],
                server: serverName,
                created_at: row.created_at
              });
            }
            res.json(encodedRows);
          });
        });

        app.get('/api/articles/:id', auth.authenticateToken, async (req, res) => {
          const { id } = req.params;
          articlesDb.get('SELECT * FROM articles WHERE id = ?', [id], async (err, row) => {
            if (err) {
              res.status(500).json({ error: err.message });
              return;
            }
            if (!row) {
              res.status(404).json({ error: 'Article not found' });
              return;
            }
            console.log('Original image path from DB for single article:', row.image); // Отладка
            const formattedImage = formatImageUrl(row.image, req);
            console.log('Formatted image URL for single article:', formattedImage); // Отладка
            
            // Проверяем, является ли значение server числовым ID
            let serverName = row.server;
            if (row.server && !isNaN(row.server) && parseInt(row.server) > 0) {
              // Это ID сервера, получаем его имя
              const serverFromDb = await getServerNameById(parseInt(row.server));
              if (serverFromDb) {
                serverName = serverFromDb;
              }
            }
            
            // Преобразование кодировки для кириллических символов и парсинг JSON полей
            const encodedRow = {
              ...row,
              title: row.title,
              content: updateImageUrlsInContent(row.content, req), // Обновляем URL изображений в содержимом
              description: row.description,
              views: row.views,
              locked: row.locked === 1,
              role: row.role,
              roles: row.role && row.role.startsWith('[') && row.role.endsWith(']') ? JSON.parse(row.role) : (row.role ? [row.role] : []),
              category: row.category,
              tags: row.tags ? JSON.parse(row.tags) : [],
              author: row.author,
              image: formattedImage,
              attachments: row.attachments ? JSON.parse(row.attachments) : [],
              server: serverName
            };
            res.json(encodedRow);
          });
        });
        
        // Функция для нормализации пути к изображению перед сохранением в базу
        function normalizeImagePath(imagePath) {
          if (!imagePath) return null;
          
          // Если это внешний URL, извлекаем только путь
          if (imagePath.startsWith('http')) {
            try {
              const url = new URL(imagePath);
              return url.pathname;
            } catch (e) {
              console.warn('Could not parse image URL, saving as is:', imagePath);
              return imagePath;
            }
          }
          
          // Если путь уже содержит uploads, но не начинается с /, добавляем /
          if (imagePath.includes('uploads') && !imagePath.startsWith('/')) {
            return '/' + imagePath;
          }
          
          // Если это просто имя файла, добавляем /uploads/
          if (!imagePath.startsWith('/') && !imagePath.includes('/')) {
            return `/uploads/${imagePath}`;
          }
          
          // В остальных случаях возвращаем как есть
          return imagePath;
        }

        app.post('/api/articles', auth.authenticateToken, (req, res) => {
          const { title, content, views, locked, role, roles, category, tags, author, image, attachments, server } = req.body;
          // Используем сервер из тела запроса, если он указан, иначе определяем на основе хоста запроса
          const articleServer = server || req.get('Host') || 'localhost';
          
          // Находим наименьший свободный ID
          articlesDb.get(`
            SELECT COALESCE(
              (SELECT MIN(t1.id + 1) 
               FROM articles t1 
               LEFT JOIN articles t2 ON t1.id + 1 = t2.id 
               WHERE t2.id IS NULL), 
              1
            ) AS next_id
          `, (err, row) => {
            if (err) {
              res.status(500).json({ error: err.message });
              return;
            }
            
            const nextId = row.next_id;
            
            // Подготавливаем данные для вставки
            const tagsJson = tags ? JSON.stringify(tags) : '[]';
            const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]';
            const lockedInt = locked ? 1 : 0;

            // Handle roles - use roles array if provided, otherwise use single role
            let roleValue = role; // Default to single role for backward compatibility
            if (roles && Array.isArray(roles) && roles.length > 0) {
                // If roles array is provided, store it as JSON
                roleValue = JSON.stringify(roles);
            } else if (role && typeof role === 'object' && Array.isArray(role)) {
                // If role field itself is an array (sent as "role" instead of "roles")
                roleValue = JSON.stringify(role);
            }

            // Нормализуем путь к изображению перед сохранением
            let imagePath = normalizeImagePath(image);

            // Вставляем новую статью с конкретным ID
            articlesDb.run(
              'INSERT INTO articles (id, title, content, views, locked, role, category, tags, author, image, attachments, server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [nextId, title, content, views || 0, lockedInt, roleValue, category, tagsJson, author, imagePath, attachmentsJson, articleServer],
              function(err) {
                if (err) {
                  res.status(500).json({ error: err.message });
                  return;
                }
                res.json({ id: nextId });
              }
            );
          });
        });

        app.put('/api/articles/:id', auth.authenticateToken, (req, res) => {
          const { id } = req.params;
          const { title, content, views, locked, role, roles, category, tags, author, image, attachments, server } = req.body;
          // Используем сервер из тела запроса, если он указан, иначе определяем на основе хоста запроса
          const articleServer = server || req.get('Host') || 'localhost';
          
          // Подготавливаем данные для обновления
          const tagsJson = tags ? JSON.stringify(tags) : '[]';
          const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]';
          const lockedInt = locked ? 1 : 0;

          // Handle roles - use roles array if provided, otherwise use single role
          let roleValue = role; // Default to single role for backward compatibility
          if (roles && Array.isArray(roles) && roles.length > 0) {
              // If roles array is provided, store it as JSON
              roleValue = JSON.stringify(roles);
          } else if (role && typeof role === 'object' && Array.isArray(role)) {
              // If role field itself is an array (sent as "role" instead of "roles")
              roleValue = JSON.stringify(role);
          }

          // Нормализуем путь к изображению перед сохранением
          let imagePath = normalizeImagePath(image);

          articlesDb.run(
            'UPDATE articles SET title = ?, content = ?, views = ?, locked = ?, role = ?, category = ?, tags = ?, author = ?, image = ?, attachments = ?, server = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [title, content, views || 0, lockedInt, roleValue, category, tagsJson, author, imagePath, attachmentsJson, articleServer, id],
            function(err) {
              if (err) {
                res.status(500).json({ error: err.message });
                return;
              }
              if (this.changes === 0) {
                res.status(404).json({ error: 'Article not found' });
                return;
              }
              res.json({ updated: this.changes });
            }
          );
        });

        // Функция для форматирования URL изображения
        function formatImageUrl(imagePath, req = null) {
    if (!imagePath) return null;
    
    // Если это уже полный URL (внешнее изображение), возвращаем как есть
    if (imagePath.startsWith('http')) {
      return imagePath;
    }
    
    // Убедимся, что путь начинается с '/', иначе добавляем
    let normalizedPath = imagePath;
    if (!imagePath.startsWith('/')) {
      normalizedPath = '/' + imagePath;
    }
    
    // Проверяем, есть ли заголовок X-Forwarded-Host (может использоваться с обратным прокси)
    if (req && req.get('X-Forwarded-Host')) {
      const protocol = req.get('X-Forwarded-Proto') || 'http';
      return `${protocol}://${req.get('X-Forwarded-Host')}${normalizedPath}`;
    }
    
    // Для доступа через DuckDNS используем внешний домен
    // Получаем внешний хост из запроса, если доступен
    if (req && req.get('Host')) {
      const host = req.get('Host');
      if (host.includes('duckdns.org')) {
        return `http://${host}${normalizedPath}`;
      }
    }
    
    // В остальных случаях используем текущий хост или локальный IP
    if (req && req.get('Host')) {
      const host = req.get('Host');
      return `http://${host}${normalizedPath}`;
    }
    
    // Получаем IP-адрес сервера для формирования корректного URL
    // при доступе с разных устройств в сети
    const serverIP = getServerIP();
    const baseUrl = `http://${serverIP}:${PORT}`;
    return baseUrl + normalizedPath;
  }

  // Функция для определения IP-адреса сервера
  function getServerIP() {
    // Если HOST уже является конкретным IP, возвращаем его
    if (HOST !== '0.0.0.0' && HOST !== 'localhost' && HOST !== '127.0.0.1') {
      return HOST;
    }
    
    // В противном случае возвращаем IP-адрес машины
    // который можно использовать из локальной сети
    const networkInterfaces = os.networkInterfaces();
    let serverIP = 'localhost'; // Значение по умолчанию
    
    for (const interfaceName in networkInterfaces) {
      const networkInterface = networkInterfaces[interfaceName];
      for (const network of networkInterface) {
        // Пропускаем локальные и IPv6 адреса
        if (!network.internal && network.family === 'IPv4') {
          serverIP = network.address;
          break;
        }
      }
      if (serverIP !== 'localhost') {
        break;
      }
    }
    
    return serverIP;
  }

app.delete('/api/articles/:id', auth.authenticateToken, (req, res) => {
  const { id } = req.params;
  articlesDb.run('DELETE FROM articles WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    res.json({ deleted: this.changes });
  });
});

// Маршрут для поиска статей с использованием полнотекстового поиска
app.get('/api/search-articles', auth.authenticateToken, async (req, res) => {
  const { q, limit = 50, offset = 0 } = req.query;
  
  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query is required' });
  }
  
  // Подготавливаем поисковый запрос
  const searchQuery = q.trim();
  
  // Используем более простой, но надежный подход с SQL LIKE для поиска
  const searchSql = `
    SELECT a.*, 
           CASE 
             WHEN a.title = ? THEN 1  -- Точное совпадение в заголовке
             WHEN a.title LIKE ? THEN 2  -- Частичное совпадение в заголовке
             ELSE 3  -- Совпадение в содержимом
           END AS sort_rank
    FROM articles a
    WHERE a.title LIKE ?
       OR a.content LIKE ?
    ORDER BY sort_rank
    LIMIT ? OFFSET ?
  `;

  // SQL для подсчета общего количества результатов (без FTS в COUNT запросе)
  const countSql = `
    SELECT COUNT(*) as total
    FROM articles a
    WHERE a.title LIKE ?
       OR a.content LIKE ?
  `;
  
  try {
    const titleExact = searchQuery;
    const titleLike = `%${searchQuery}%`;
    const contentLike = `%${searchQuery}%`;

    // Получаем количество результатов
    articlesDb.get(countSql, [titleLike, contentLike], (err, countRow) => {
      if (err) {
        console.error('Search count error:', err);
        return res.status(500).json({ error: err.message });
      }

      const total = countRow ? countRow.total : 0;

      // Получаем статьи с объединенным поиском и сортировкой
      articlesDb.all(searchSql, [titleExact, titleLike, titleLike, contentLike, parseInt(limit), parseInt(offset)], async (err, rows) => {
        if (err) {
          console.error('Search error:', err);
          return res.status(500).json({ error: err.message });
        }
        
        // Преобразование кодировки для кириллических символов и парсинг JSON полей
        const encodedRows = [];
        for (const row of rows) {
          console.log('Original image path from DB:', row.image); // Отладка
          const formattedImage = formatImageUrl(row.image, req);
          console.log('Formatted image URL:', formattedImage); // Отладка
          
          // Проверяем, является ли значение server числовым ID
          let serverName = row.server;
          if (row.server && !isNaN(row.server) && parseInt(row.server) > 0) {
            // Это ID сервера, получаем его имя
            const serverFromDb = await getServerNameById(parseInt(row.server));
            if (serverFromDb) {
              serverName = serverFromDb;
            }
          }
          
          encodedRows.push({
            ...row,
            title: row.title,
            content: updateImageUrlsInContent(row.content, req), // Обновляем URL изображений в содержимом
            views: row.views,
            locked: row.locked === 1,
            role: row.role,
            category: row.category,
            tags: row.tags ? JSON.parse(row.tags) : [],
            author: row.author,
            image: formattedImage,
            attachments: row.attachments ? JSON.parse(row.attachments) : [],
            server: serverName,
            created_at: row.created_at,
            relevance_score: (row.sort_rank === 1) ? 100 : (row.sort_rank === 2) ? 80 : (row.sort_rank === 3) ? 60 : 40
          });
        }
        
        res.json({
          success: true,
          data: encodedRows,
          total: total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          query: q
        });
      });
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API маршруты для категорий
app.get('/api/categories', auth.authenticateToken, (req, res) => {
  articlesDb.all('SELECT * FROM categories ORDER BY name', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.post('/api/categories', auth.authenticateToken, (req, res) => {
  const { name } = req.body;
  articlesDb.run('INSERT INTO categories (name) VALUES (?)', [name], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ id: this.lastID, name });
  });
});

app.delete('/api/categories/:id', auth.authenticateToken, (req, res) => {
  const { id } = req.params;
  articlesDb.run('DELETE FROM categories WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    res.json({ deleted: this.changes });
  });
});

// API маршруты для ролей
app.get('/api/roles', auth.authenticateToken, (req, res) => {
  // Получаем роли из базы пользователей
  const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));
  usersDb.all('SELECT * FROM roles ORDER BY name', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
    usersDb.close();
  });
});

app.post('/api/roles', auth.authenticateToken, (req, res) => {
  const { name, code } = req.body;
  const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));
  usersDb.run('INSERT INTO roles (name, code) VALUES (?, ?)', [name, code], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      usersDb.close();
      return;
    }
    res.json({ id: this.lastID, name, code });
    usersDb.close();
  });
});

app.delete('/api/roles/:id', auth.authenticateToken, (req, res) => {
  const { id } = req.params;
  const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));
  usersDb.run('DELETE FROM roles WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      usersDb.close();
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Role not found' });
      usersDb.close();
      return;
    }
    res.json({ deleted: this.changes });
    usersDb.close();
  });
});

// Импортируем логику для системы серверов
const serverSystem = require('./server-system-logic');

// === API маршруты для системы серверов ===

// Получение всех серверов
app.get('/api/servers', auth.authenticateToken, async (req, res) => {
  try {
    const servers = await serverSystem.getAllServersWithUserCount();
    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение сервера по ID
app.get('/api/servers/:id', auth.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const server = await serverSystem.getServerWithDetails(id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание нового сервера
app.post('/api/servers', auth.authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    // В реальной системе owner_id должен быть из req.user.id (аутентифицированный пользователь)
    const server = await serverSystem.createServer(name, description, req.user.id);
    // Добавляем владельца как администратора сервера
    await serverSystem.addUserToServer(req.user.id, server.id);
    // Назначаем роль администратора владельцу
    const roles = await serverSystem.getRolesOnServer(server.id);
    const adminRole = roles.find(role => role.name === 'admin' && role.role_type === 'system');
    if (adminRole) {
      await serverSystem.assignRoleToUserOnServer(req.user.id, server.id, adminRole.id);
    }
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление сервера
app.put('/api/servers/:id', auth.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const userId = req.user.id;
    
    // Проверяем, что пользователь является владельцем сервера
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    serversDb.get('SELECT owner_id FROM servers WHERE id = ?', [id], async (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        serversDb.close();
        return;
      }
      
      if (!row) {
        res.status(404).json({ error: 'Server not found' });
        serversDb.close();
        return;
      }
      
      if (row.owner_id !== userId) {
        res.status(403).json({ error: 'Only server owner can update server' });
        serversDb.close();
        return;
      }
      
      const result = await serverSystem.updateServer(id, name, description);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Server not found' });
      } else {
        res.json({ updated: result.changes, serverId: id });
      }
      serversDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление сервера
app.delete('/api/servers/:id', auth.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Проверяем, что пользователь является владельцем сервера
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    serversDb.get('SELECT owner_id FROM servers WHERE id = ?', [id], async (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        serversDb.close();
        return;
      }
      
      if (!row) {
        res.status(404).json({ error: 'Server not found' });
        serversDb.close();
        return;
      }
      
      if (row.owner_id !== userId) {
        res.status(403).json({ error: 'Only server owner can delete server' });
        serversDb.close();
        return;
      }
      
      const result = await serverSystem.deleteServer(id);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Server not found' });
      } else {
        res.json({ deleted: result.changes, serverId: id });
      }
      serversDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение пользователей на сервере
app.get('/api/servers/:id/users', auth.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const users = await serverSystem.getUsersOnServer(id);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение ролей на сервере
app.get('/api/servers/:id/roles', auth.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const roles = await serverSystem.getRolesOnServer(id);
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Импортируем утилиты для проверки прав
const { isAdminOnServer, hasPermission, canManageUser } = require('./server-permissions');

// Создание роли на сервере
app.post('/api/servers/:id/roles', auth.authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, hierarchy_level, permissions } = req.body;
    const userId = req.user.id;
    
    // Проверяем, что пользователь является администратором сервера
    const isAdmin = await isAdminOnServer(userId, parseInt(id));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can create roles' });
    }
    
    const role = await serverSystem.createRoleOnServer(id, name, hierarchy_level, permissions);
    res.json(role);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Добавление пользователя к серверу
app.post('/api/servers/:serverId/users/:userId', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId, userId } = req.params;
    const result = await serverSystem.addUserToServer(userId, serverId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Назначение роли пользователю на сервере
app.post('/api/servers/:serverId/users/:userId/roles/:roleId', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId, userId, roleId } = req.params;
    const currentUserId = req.user.id;
    
    // Проверяем, что текущий пользователь является администратором сервера
    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can assign roles' });
    }
    
    // Проверяем, может ли текущий пользователь управлять целевым пользователем (по иерархии ролей)
    const canManage = await canManageUser(currentUserId, parseInt(userId), parseInt(serverId));
    if (!canManage) {
      return res.status(403).json({ error: 'Cannot assign roles to users with higher or equal hierarchy level' });
    }
    
    const result = await serverSystem.assignRoleToUserOnServer(userId, serverId, roleId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление роли с пользователя на сервере
app.delete('/api/servers/:serverId/users/:userId/roles/:roleId', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId, userId, roleId } = req.params;
    const currentUserId = req.user.id;
    
    // Проверяем, что текущий пользователь является администратором сервера
    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can remove roles' });
    }
    
    // Проверяем, может ли текущий пользователь управлять целевым пользователем (по иерархии ролей)
    const canManage = await canManageUser(currentUserId, parseInt(userId), parseInt(serverId));
    if (!canManage) {
      return res.status(403).json({ error: 'Cannot remove roles from users with higher or equal hierarchy level' });
    }
    
    // В текущей реализации нужно использовать прямой SQL запрос для удаления роли
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    serversDb.run('DELETE FROM user_server_role_assignments WHERE user_id = ? AND server_id = ? AND role_id = ?', 
      [userId, serverId, roleId], function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          res.json({ deleted: this.changes, userId, serverId, roleId });
        }
        serversDb.close();
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление роли на сервере
app.delete('/api/servers/:serverId/roles/:roleId', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId, roleId } = req.params;
    const currentUserId = req.user.id;
    
    // Проверяем, что текущий пользователь является администратором сервера
    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can delete roles' });
    }
    
    // В текущей реализации нужно использовать прямой SQL запрос для удаления роли
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    // Не позволяем удалять системные роли
    serversDb.get('SELECT role_type FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId], (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        serversDb.close();
        return;
      }
      
      if (!row) {
        res.status(404).json({ error: 'Role not found' });
        serversDb.close();
        return;
      }
      
      if (row.role_type === 'system') {
        res.status(403).json({ error: 'Cannot delete system roles' });
        serversDb.close();
        return;
      }
      
      // Удаляем роль
      serversDb.run('DELETE FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId], function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          res.json({ deleted: this.changes, roleId, serverId });
        }
        serversDb.close();
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление роли на сервере
app.put('/api/servers/:serverId/roles/:roleId', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId, roleId } = req.params;
    const { name, hierarchy_level, permissions } = req.body;
    const currentUserId = req.user.id;
    
    // Проверяем, что текущий пользователь является администратором сервера
    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can update roles' });
    }
    
    // В текущей реализации нужно использовать прямой SQL запрос для обновления роли
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    // Не позволяем изменять системные роли
    const permissionsStr = JSON.stringify(permissions);
    
    serversDb.run('UPDATE server_roles SET name = ?, hierarchy_level = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND server_id = ?', 
      [name, hierarchy_level, permissionsStr, roleId, serverId], function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          if (this.changes === 0) {
            res.status(404).json({ error: 'Role not found or does not belong to this server' });
          } else {
            res.json({ updated: this.changes, roleId, serverId, name, hierarchy_level, permissions });
          }
        }
        serversDb.close();
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление владельца сервера
app.put('/api/servers/:serverId/owner', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId } = req.params;
    const { newOwnerId } = req.body;
    const currentUserId = req.user.id;
    
    // Проверяем, что текущий пользователь является администратором (имеет право изменять владельца)
    const currentUser = await auth.getUserById(currentUserId);
    if (!currentUser || currentUser.role_id !== 1) { // Предполагаем, что role_id = 1 для администраторов
      return res.status(403).json({ error: 'Only administrators can change server owner' });
    }
    
    // Проверяем, что новый владелец существует
    const newOwner = await auth.getUserById(newOwnerId);
    if (!newOwner) {
      return res.status(404).json({ error: 'New owner not found' });
    }
    
    // Обновляем владельца сервера
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    serversDb.run('UPDATE servers SET owner_id = ? WHERE id = ?', [newOwnerId, serverId], function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        if (this.changes === 0) {
          res.status(404).json({ error: 'Server not found' });
        } else {
          res.json({ updated: this.changes, serverId, newOwnerId });
        }
      }
      serversDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Инициализируем планировщик очистки мусорных файлов
require('./scheduled-cleanup');

// Запуск сервера
app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}`);
  console.log(`Access locally: http://localhost:${PORT}`);
  console.log(`Access from network: http://[YOUR_LOCAL_IP]:${PORT} (replace [YOUR_LOCAL_IP] with your actual IP)`);
  console.log(`Test interface available at http://localhost:${PORT}/test.html or http://[YOUR_LOCAL_IP]:${PORT}/test.html`);
});

// === Примечание о роли "наблюдатель" ===
// Роль "наблюдатель" добавляется на клиентской стороне в интерфейсе создания/редактирования статей
// Она доступна как выбор в выпадающем списке "Видно для роли"
// и дает минимальные права - только чтение контента

// Получение статуса наблюдателя пользователя
app.get('/api/profile/observer-status', auth.authenticateToken, async (req, res) => {
  try {
    const { assignObserverRoleIfNeeded } = require('./server-membership-check');
    const observerCheck = await assignObserverRoleIfNeeded(req.user.id);
    res.json(observerCheck);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

        // Маршрут для загрузки изображений
        app.post('/api/upload-image', auth.authenticateToken, upload.single('image'), (req, res) => {
          try {
            if (!req.file) {
              return res.status(400).json({ error: 'Файл не загружен' });
            }
            
            // Проверяем, что файл действительно существует
            const fs = require('fs');
            const filePath = path.join(__dirname, 'public', 'uploads', req.file.filename);
            
            if (!fs.existsSync(filePath)) {
              console.error('Uploaded file not found:', filePath);
              return res.status(500).json({ error: 'Ошибка сохранения файла' });
            }
            
            // Возвращаем путь к загруженному файлу (без домена), чтобы сервер мог его нормализовать
            res.setHeader('Content-Type', 'application/json');
            res.json({ url: `/uploads/${req.file.filename}` });
          } catch (error) {
            console.error('Upload error:', error);
            res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке: ' + error.message });
          }
        });
        
        // Обработка ошибок multer для загрузки изображений
        app.use((err, req, res, next) => {
          if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
              return res.status(400).json({ error: 'Файл слишком большой. Максимальный размер: 5MB' });
            }
            return res.status(400).json({ error: 'Ошибка загрузки файла: ' + err.message });
          } else if (err) {
            console.error('General upload error:', err);
            return res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + err.message });
          }
          next();
        });

// Функция для проверки, является ли пользователь администратором
async function isAdminUser(userId) {
  try {
    const user = await auth.getUserById(userId);
    return user && user.role_id === 1; // Предполагаем, что role_id = 1 для администраторов
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

// Удаление сервера
app.delete('/api/servers/:serverId', auth.authenticateToken, async (req, res) => {
  try {
    const { serverId } = req.params;
    const currentUserId = req.user.id;
    
    // Проверяем, что текущий пользователь является администратором
    const isAdmin = await isAdminUser(currentUserId);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can delete servers' });
    }
    
    // Удаляем сервер и все связанные данные
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const serversDb = new db(path.join(__dirname, 'servers.db'));
    
    serversDb.serialize(() => {
      // Начинаем транзакцию
      serversDb.run('BEGIN TRANSACTION');
      
      // Удаляем все роли на сервере
      serversDb.run('DELETE FROM server_roles WHERE server_id = ?', [serverId], function(err) {
        if (err) {
          serversDb.run('ROLLBACK');
          res.status(500).json({ error: err.message });
          serversDb.close();
          return;
        }
        
        // Удаляем все участников сервера
        serversDb.run('DELETE FROM user_server_memberships WHERE server_id = ?', [serverId], function(err) {
          if (err) {
            serversDb.run('ROLLBACK');
            res.status(500).json({ error: err.message });
            serversDb.close();
            return;
          }
          
          // Удаляем все назначения ролей пользователей на сервере
          serversDb.run('DELETE FROM user_server_role_assignments WHERE server_id = ?', [serverId], function(err) {
            if (err) {
              serversDb.run('ROLLBACK');
              res.status(500).json({ error: err.message });
              serversDb.close();
              return;
            }
            
            // Удаляем все каналы сервера
            serversDb.run('DELETE FROM server_channels WHERE server_id = ?', [serverId], function(err) {
              if (err) {
                serversDb.run('ROLLBACK');
                res.status(500).json({ error: err.message });
                serversDb.close();
                return;
              }
              
              // Удаляем сам сервер
              serversDb.run('DELETE FROM servers WHERE id = ?', [serverId], function(err) {
                if (err) {
                  serversDb.run('ROLLBACK');
                  res.status(500).json({ error: err.message });
                  serversDb.close();
                  return;
                }
                
                // Если сервер не найден
                if (this.changes === 0) {
                  serversDb.run('ROLLBACK');
                  res.status(404).json({ error: 'Server not found' });
                } else {
                  // Коммитим транзакцию
                  serversDb.run('COMMIT');
                  res.json({ deleted: this.changes, serverId });
                }
                serversDb.close();
              });
            });
          });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение всех пользователей (для выбора нового владельца сервера)
app.get('/api/users', auth.authenticateToken, async (req, res) => {
  try {
    // Проверяем, что текущий пользователь является администратором
    const isAdmin = await isAdminUser(req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can access user list' });
    }

    // Получаем всех пользователей
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const usersDb = new db(path.join(__dirname, 'users.db'));

    usersDb.all('SELECT id, username FROM users ORDER BY username', [], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true, data: rows });
      }
      usersDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all route handler for SPA (should be placed after all API routes)
app.get('*', (req, res) => {
  // Only serve index.html for routes that are not API or static files
  if (!req.path.startsWith('/api/') &&
      !req.path.startsWith('/uploads/') &&
      !req.path.startsWith('/views/') &&
      !req.path.endsWith('.js') &&
      !req.path.endsWith('.css') &&
      !req.path.endsWith('.png') &&
      !req.path.endsWith('.jpg') &&
      !req.path.endsWith('.jpeg') &&
      !req.path.endsWith('.gif') &&
      !req.path.endsWith('.svg') &&
      !req.path.endsWith('.ico')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    // For other routes, send 404 since they weren't handled by previous routes
    res.status(404).send('File not found');
  }
});