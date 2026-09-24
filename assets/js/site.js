// Add anchor links to every heading in article content
document.addEventListener('DOMContentLoaded', function () {
  var headings = document.querySelectorAll('.markdown-body h2, .markdown-body h3, .markdown-body h4');
  headings.forEach(function (h) {
    if (!h.id) return;
    var a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.setAttribute('aria-label', 'Link to this section');
    a.textContent = '#';
    h.appendChild(a);
  });
});