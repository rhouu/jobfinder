// Scroll-reveal for public portfolio sections
(function () {
  const items = document.querySelectorAll(".pf-section, .pf-card, .pf-item");
  if (!("IntersectionObserver" in window)) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); obs.unobserve(e.target); } });
  }, { threshold: 0.1 });
  items.forEach((el, i) => {
    el.classList.add("pf-reveal");
    el.style.transitionDelay = `${(i % 4) * 0.08}s`;
    obs.observe(el);
  });
})();
