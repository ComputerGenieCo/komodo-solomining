function initTheme() {
    // Check for saved theme preference or default to light
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', theme);

    // Update toggle button state
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.checked = theme === 'dark';
    }
}

function toggleTheme() {
    const theme = document.documentElement.getAttribute('data-bs-theme');
    const newTheme = theme === 'light' ? 'dark' : 'light';

    document.documentElement.setAttribute('data-bs-theme', newTheme);
    localStorage.setItem('theme', newTheme);
}

// Initialize theme when DOM loads
document.addEventListener('DOMContentLoaded', initTheme);
