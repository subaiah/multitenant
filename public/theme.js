// Applies the saved colour theme before the app draws, so dark mode doesn't
// flash white. A file rather than inline script: the content policy allows
// only scripts from this site. Kept in step with src/contexts/ThemeContext.tsx.
(function () {
  var choice = 'system';
  try { choice = localStorage.getItem('theme') || 'system'; } catch (e) { /* storage blocked */ }
  var dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
