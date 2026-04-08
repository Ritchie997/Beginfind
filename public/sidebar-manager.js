// sidebar-manager.js - Менеджер бокового меню админ-панели

// Функция для обновления меню
function updateSidebar() {
    // Обновляем активный элемент меню
    const allSidebarItems = document.querySelectorAll('.sidebar-item');
    allSidebarItems.forEach(item => {
        item.classList.remove('active');
        
        // Проверяем, соответствует ли элемент текущему пути
        // Проверяем как data-nav атрибут, так и onclick для совместимости
        const navPath = item.getAttribute('data-nav') || getOnclickPath(item);
        if (navPath) {
            if (window.location.pathname === navPath || 
                (navPath === '/dashboard.html' && window.location.pathname === '/') ||
                (navPath === '/dashboard.html' && window.location.pathname === '/dashboard.html')) {
                    item.classList.add('active');
                }
        }
    });
    
    // Делаем вкладку "Серверы" всегда видимой
    const serverItems = document.querySelectorAll('.sidebar-item[data-nav*=\"/servers\"], .sidebar-item[onclick*=\"/servers\"]');
    serverItems.forEach(item => {
        item.style.display = 'flex';
    });
}

// Вспомогательная функция для извлечения пути из onclick атрибута для совместимости
function getOnclickPath(item) {
    const onclickAttr = item.getAttribute('onclick');
    if (onclickAttr) {
        const pathMatch = onclickAttr.match(/window\.location\.href='([^']+)'/);
        if (pathMatch && pathMatch[1]) {
            return pathMatch[1];
        }
    }
    return null;
}

// Функция для переключения бокового меню на мобильных устройствах
function toggleMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const hamburger = document.querySelector('.hamburger-menu');
    const overlay = document.querySelector('.sidebar-overlay');
    
    if (sidebar && hamburger) {
        sidebar.classList.toggle('active');
        hamburger.classList.toggle('active');
        
        // Показываем/скрываем оверлей
        if (overlay) {
            overlay.classList.toggle('active');
        }
    }
}

// Функция для закрытия бокового меню на мобильных устройствах
function closeMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const hamburger = document.querySelector('.hamburger-menu');
    const overlay = document.querySelector('.sidebar-overlay');
    
    if (sidebar && hamburger) {
        sidebar.classList.remove('active');
        hamburger.classList.remove('active');
        
        // Скрываем оверлей
        if (overlay) {
            overlay.classList.remove('active');
        }
    }
}

// Инициализация меню при загрузке страницы
document.addEventListener('DOMContentLoaded', function() {
    updateSidebar();
    
    // Добавляем обработчик для гамбургер-кнопки
    const hamburger = document.querySelector('.hamburger-menu');
    if (hamburger) {
        hamburger.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleMobileMenu();
        });
    }
    
    // Закрываем меню при клике вне его области
    document.addEventListener('click', function(e) {
        const sidebar = document.querySelector('.sidebar');
        const hamburger = document.querySelector('.hamburger-menu');
        
        if (sidebar && hamburger) {
            const isClickInsideSidebar = sidebar.contains(e.target);
            const isClickOnHamburger = hamburger.contains(e.target);
            
            if (!isClickInsideSidebar && !isClickOnHamburger && sidebar.classList.contains('active')) {
                closeMobileMenu();
            }
        }
    });
    
    // Закрываем меню при изменении размера экрана, если ширина больше 768px
    window.addEventListener('resize', function() {
        if (window.innerWidth > 768) {
            closeMobileMenu();
        }
    });
    
    // Создаем оверлей для затемнения фона при открытом меню
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
    
    // Добавляем обработчик клика на оверлей для закрытия меню
    overlay.addEventListener('click', function() {
        closeMobileMenu();
    });
});

// Экспортируем функции для использования в других скриптах
if (typeof window !== 'undefined') {
    window.updateSidebar = updateSidebar;
    window.toggleMobileMenu = toggleMobileMenu;
    window.closeMobileMenu = closeMobileMenu;
}