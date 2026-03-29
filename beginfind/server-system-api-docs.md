# API Документация для системы серверов

## Маршруты для серверов

### GET /api/servers
- Получить список всех серверов
- Требует аутентификации
- Ответ: массив объектов серверов

### GET /api/servers/:id
- Получить информацию о конкретном сервере
- Требует аутентификации
- Ответ: объект сервера с деталями

### POST /api/servers
- Создать новый сервер
- Требует аутентификации
- Тело запроса: {name: string, description: string}
- При создании автоматически добавляется создатель как администратор
- Ответ: объект созданного сервера

### PUT /api/servers/:id
- Обновить информацию о сервере
- Может выполнить только владелец сервера
- Требует аутентификации
- Тело запроса: {name: string, description: string}
- Ответ: информация об обновлении

### DELETE /api/servers/:id
- Удалить сервер
- Может выполнить только владелец сервера
- Требует аутентификации
- Ответ: информация об удалении

## Маршруты для управления пользователями

### GET /api/servers/:id/users
- Получить список пользователей на сервере
- Требует аутентификации
- Ответ: массив объектов пользователей с ролями

### POST /api/servers/:serverId/users/:userId
- Добавить пользователя к серверу
- Требует аутентификации
- Ответ: информация о добавлении

### POST /api/servers/:serverId/users/:userId/roles/:roleId
- Назначить роль пользователю на сервере
- Может выполнить только администратор сервера
- Пользователь может назначать роли только пользователям с более низким уровнем иерархии
- Требует аутентификации
- Ответ: информация о назначении роли

## Маршруты для управления ролями

### GET /api/servers/:id/roles
- Получить список всех ролей на сервере (включая системные)
- Требует аутентификации
- Ответ: массив объектов ролей

### POST /api/servers/:id/roles
- Создать новую кастомную роль на сервере
- Может выполнить только администратор сервера
- Требует аутентификации
- Тело запроса: {
    name: string,
    hierarchy_level: number,
    permissions: {
      send_messages: boolean,
      manage_channels: boolean,
      ban_users: boolean,
      manage_roles: boolean,
      read_messages: boolean
    }
  }
- Ответ: объект созданной роли

## Примеры использования

### Создание сервера
```javascript
fetch('/api/servers', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Мой сервер',
    description: 'Описание моего сервера'
  })
})
```

### Получение пользователей на сервере
```javascript
fetch('/api/servers/1/users', {
  headers: {
    'Authorization': 'Bearer ' + token
  }
})
```

### Назначение роли пользователю
```javascript
fetch('/api/servers/1/users/5/roles/10', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token
  }
})
```

## Структура данных

### Сервер
```javascript
{
  id: number,
  name: string,
  description: string,
  owner_id: number,
  created_at: string,
  updated_at: string
}
```

### Роль
```javascript
{
  id: number,
  server_id: number, // null для системных ролей
  name: string,
  role_type: 'system' | 'custom',
  hierarchy_level: number,
  permissions: {
    send_messages: boolean,
    manage_channels: boolean,
    ban_users: boolean,
    manage_roles: boolean,
    read_messages: boolean
  },
  created_at: string,
  updated_at: string
}
```

### Пользователь на сервере
```javascript
{
  id: number,
  username: string,
  roles: [
    {
      id: number,
      name: string,
      type: string,
      hierarchy_level: number
    }
  ]
}
```

## Права и ограничения

1. Только владелец сервера может обновлять или удалять сервер
2. Только администраторы сервера могут создавать роли и назначать роли другим пользователям
3. Пользователь может управлять только теми, у кого уровень иерархии ниже
4. Системные роли (admin, observer, member) доступны на всех серверах
5. Кастомные роли уникальны для каждого сервера