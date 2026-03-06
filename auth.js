// auth.js — protección de páginas
(function () {
  const token = sessionStorage.getItem('bdns_token');
  if (!token) {
    window.location.href = '/login.html';
    return;
  }

  // Mostrar usuario en header
  const usuario = sessionStorage.getItem('bdns_usuario');
  const rol     = sessionStorage.getItem('bdns_rol') || 'usuario';

  // Bloquear acceso directo a admin.html si no es admin ni gestor
  if (window.location.pathname === '/admin.html' && rol !== 'admin' && rol !== 'gestor') {
    window.location.href = '/index.html';
    return;
  }

  document.addEventListener('DOMContentLoaded', function () {
    const el = document.getElementById('usuarioActual');
    if (el && usuario) el.textContent = usuario;

    // Ocultar Admin BD si no es admin ni gestor
    if (rol !== 'admin' && rol !== 'gestor') {
      const adminLink = document.getElementById('adminLink');
      if (adminLink) adminLink.style.display = 'none';
    }
  });

  // Inyectar token en todas las llamadas a /api/
  const _fetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts || {};
    if (typeof url === 'string' && url.startsWith('/api/')) {
      opts.headers = Object.assign({}, opts.headers, { 'X-Token': token });
    }
    return _fetch(url, opts);
  };
})();

function logout() {
  sessionStorage.clear();
  window.location.href = '/login.html';
}