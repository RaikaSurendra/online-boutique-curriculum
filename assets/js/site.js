// Add anchor links to headings inside article content
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.markdown h2, .markdown h3, .markdown h4').forEach(function (h) {
    if (!h.id) return;
    var a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.setAttribute('aria-label', 'Link to this section');
    a.textContent = '#';
    h.appendChild(a);
  });
});