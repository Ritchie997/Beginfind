// app.js - Global application functions and utilities

// Global shared functions
window.showMessage = function(text, type = 'info') {
  // Remove any existing message containers
  const existingMessage = document.getElementById('message-container');
  if (existingMessage) {
    existingMessage.remove();
  }

  // Create message container
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
    animation: slideInRight 0.3s ease;
  `;
  messageContainer.textContent = text;

  document.body.appendChild(messageContainer);

  // Remove message after 5 seconds
  setTimeout(() => {
    if (messageContainer.parentNode) {
      messageContainer.remove();
    }
  }, 5000);
};

// Function to update user info in UI
window.updateUserInfo = function() {
  try {
    const currentUser = authManager.getCurrentUser();
    if (currentUser && currentUser.username) {
      // Update displayed username
      const usernameDisplay = document.querySelector('.username-display');
      if (usernameDisplay) {
        usernameDisplay.textContent = currentUser.username;
      }

      // Update avatar (using first letter of username)
      const userAvatar = document.querySelector('.user-avatar');
      if (userAvatar) {
        userAvatar.textContent = currentUser.username.charAt(0).toUpperCase();
      }
    }
  } catch (error) {
    console.error('Error updating user info:', error);
  }
};

// Improved API Client with error handling and caching
class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || this.getBaseUrl();
    this.cache = new Map(); // Simple cache for fetched templates
  }

  // Function to determine correct baseUrl
  getBaseUrl() {
    // Check if using DuckDNS domain
    if (window.location.hostname.includes('duckdns.org')) {
      // Use current host (DuckDNS domain)
      return window.location.protocol + '//' + window.location.host;
    } else {
      // If using IP address, use it as is
      return window.location.protocol + '//' + window.location.host;
    }
  }

  // Add caching for templates to improve performance
  async getCachedTemplate(templatePath) {
    const cacheKey = `template_${templatePath}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached) {
      // Return cached template if available and not too old (5 minutes)
      if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
        return cached.data;
      } else {
        // Remove expired cache
        this.cache.delete(cacheKey);
      }
    }

    // Fetch new template if not cached or expired
    const response = await fetch(templatePath);
    const html = await response.text();

    // Store in cache
    this.cache.set(cacheKey, {
      data: html,
      timestamp: Date.now()
    });

    return html;
  }

  // Enhanced error handling with automatic token refresh
  async makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
    // Check authentication via authManager
    if (!authManager || !authManager.isAuthenticated()) {
      return { success: false, error: 'Authentication required. Please log in.' };
    }

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authManager.getToken()}`
      },
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, options);

      // If we get authentication error, reset token via authManager
      if (response.status === 401 || response.status === 403) {
        authManager.logout();
        return { success: false, error: 'Authentication required. Please log in.' };
      }

      const result = await response.json();
      return { success: response.ok, data: result, status: response.status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Methods for articles
  async getArticles(since = null) {
    const endpoint = since ? `/api/articles?since=${since}` : '/api/articles';
    return this.makeAuthenticatedRequest(endpoint);
  }

  async getArticle(id) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}`);
  }

  async createArticle(articleData) {
    return this.makeAuthenticatedRequest('/api/articles', 'POST', articleData);
  }

  async updateArticle(id, articleData) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}`, 'PUT', articleData);
  }

  async deleteArticle(id) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}`, 'DELETE');
  }

  // Search articles method
  async searchArticles(query, limit = 50, offset = 0) {
    const params = new URLSearchParams({
      q: query,
      limit: limit,
      offset: offset
    });
    const result = await this.makeAuthenticatedRequest(`/api/search-articles?${params.toString()}`);

    if (result.success && result.data && Array.isArray(result.data.data)) {
      return {
        success: true,
        data: result.data
      };
    } else if (result.success && Array.isArray(result.data)) {
      return {
        success: true,
        data: {
          data: result.data,
          total: result.data.length,
          limit: limit,
          offset: offset,
          query: query
        }
      };
    } else if (result.success && result.data && result.data.data) {
      return result;
    } else {
      return result;
    }
  }

  // Methods for categories
  async getCategories() {
    return this.makeAuthenticatedRequest('/api/categories');
  }

  async createCategory(name) {
    return this.makeAuthenticatedRequest('/api/categories', 'POST', { name });
  }

  async deleteCategory(id) {
    return this.makeAuthenticatedRequest(`/api/categories/${id}`, 'DELETE');
  }

  // Methods for roles
  async getRoles() {
    return this.makeAuthenticatedRequest('/api/roles');
  }

  async createRole(name, code) {
    return this.makeAuthenticatedRequest('/api/roles', 'POST', { name, code });
  }

  async deleteRole(id) {
    return this.makeAuthenticatedRequest(`/api/roles/${id}`, 'DELETE');
  }

  // Methods for messages
  async getMessages() {
    return this.makeAuthenticatedRequest('/api/messages');
  }

  async createMessage(sender, content) {
    return this.makeAuthenticatedRequest('/api/messages', 'POST', { sender, content });
  }

  // Method for uploading images
  async uploadImage(file) {
    if (!authManager || !authManager.isAuthenticated()) {
      return { success: false, error: 'Authentication required. Please log in.' };
    }

    const formData = new FormData();
    formData.append('image', file);

    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authManager.getToken()}`
      },
      body: formData
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/upload-image`, options);

      if (response.status === 401 || response.status === 403) {
        authManager.logout();
        return { success: false, error: 'Authentication required. Please log in.' };
      }

      const result = await response.json();
      return { success: response.ok, data: result, status: response.status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Methods for servers
  async getServers() {
    return this.makeAuthenticatedRequest('/api/servers');
  }

  async getServer(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}`);
  }

  async createServer(serverData) {
    return this.makeAuthenticatedRequest('/api/servers', 'POST', serverData);
  }

  async updateServer(serverId, serverData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}`, 'PUT', serverData);
  }

  async deleteServer(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}`, 'DELETE');
  }

  async getServerUsers(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users`);
  }

  async addServerUser(serverId, userId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}`, 'POST', {});
  }

  async removeServerUser(serverId, userId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}`, 'DELETE');
  }

  async getServerRoles(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);
  }

  async createServerRole(serverId, roleData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`, 'POST', roleData);
  }

  async updateServerRole(serverId, roleId, roleData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles/${roleId}`, 'PUT', roleData);
  }

  async deleteServerRole(serverId, roleId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles/${roleId}`, 'DELETE');
  }

  async assignRoleToUser(serverId, userId, roleId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}/roles/${roleId}`, 'POST', {});
  }

  async removeRoleFromUser(serverId, userId, roleId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}/roles/${roleId}`, 'DELETE');
  }

  // Profile methods
  async getProfile() {
    return this.makeAuthenticatedRequest('/api/profile', 'GET');
  }

  async getObserverStatus() {
    return this.makeAuthenticatedRequest('/api/profile/observer-status');
  }
}

// Create global instance of the improved API client
const apiClient = new ApiClient();

// Global utility functions
window.apiClient = apiClient;
window.showMessage = showMessage;
window.updateUserInfo = updateUserInfo;

// Skeleton screens generator
window.createSkeletonScreen = function(className) {
  const skeleton = document.createElement('div');
  skeleton.className = `skeleton ${className}`;
  skeleton.innerHTML = `
    <div class="skeleton-line"></div>
    <div class="skeleton-line"></div>
    <div class="skeleton-line short"></div>
  `;
  return skeleton;
};

// Debounce function for auto-saving settings
window.debounce = function(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// Ripple effect for buttons
window.initRippleEffect = function() {
  document.addEventListener('click', function(e) {
    if (e.target.closest('.btn')) {
      const button = e.target.closest('.btn');
      
      // Don't create ripple if button is too small
      if (button.offsetWidth < 40 || button.offsetHeight < 40) return;
      
      const circle = document.createElement('span');
      const diameter = Math.max(button.clientWidth, button.clientHeight);
      const radius = diameter / 2;

      const rect = button.getBoundingClientRect();

      circle.style.width = circle.style.height = `${diameter}px`;
      circle.style.left = `${e.clientX - rect.left - radius}px`;
      circle.style.top = `${e.clientY - rect.top - radius}px`;
      circle.classList.add('ripple');

      const existingRipple = button.querySelector('.ripple');
      if (existingRipple) {
        existingRipple.remove();
      }

      button.appendChild(circle);

      setTimeout(() => {
        circle.remove();
      }, 600);
    }
  });
};

// Initialize animations on page load
window.initPageAnimations = function() {
  // Add page-content class to main content areas
  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.classList.add('page-content');
  }

  // Add stagger animation to list items
  const lists = document.querySelectorAll('.article-item, .category-item, .server-card-item, .activity-item');
  lists.forEach((item, index) => {
    item.style.animationDelay = `${index * 0.05}s`;
    item.classList.add('stagger-item');
  });

  // Initialize ripple effect
  window.initRippleEffect();
};

// Add tooltip functionality
window.initTooltips = function() {
  document.addEventListener('mouseover', function(e) {
    const tooltip = e.target.closest('[data-tooltip]');
    if (tooltip) {
      // Tooltip styles are handled by CSS
    }
  });
};

// Initialize everything when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    window.initPageAnimations();
    window.initTooltips();
  });
} else {
  window.initPageAnimations();
  window.initTooltips();
}