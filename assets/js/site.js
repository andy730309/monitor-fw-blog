(function () {
  // dark-mode toggle: cycles explicit light/dark; default follows prefers-color-scheme
  var btn = document.getElementById("theme-toggle");
  if (btn) btn.addEventListener("click", function () {
    var root = document.documentElement, cur = root.getAttribute("data-theme");
    if (!cur) cur = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) {}
  });
  // auto table of contents from h2/h3 (kramdown already adds ids)
  var toc = document.getElementById("toc"), list = document.getElementById("toc-list");
  if (toc && list) {
    var hs = document.querySelectorAll(".post-content h2[id], .post-content h3[id]");
    if (hs.length >= 3) {
      var curLi = null;
      hs.forEach(function (h) {
        var li = document.createElement("li"), a = document.createElement("a");
        a.href = "#" + h.id; a.textContent = h.textContent; li.appendChild(a);
        if (h.tagName === "H3" && curLi) {
          var sub = curLi.querySelector("ol") || curLi.appendChild(document.createElement("ol"));
          sub.appendChild(li);
        } else { list.appendChild(li); curLi = li; }
      });
      toc.hidden = false;
    }
  }
  // copy button on code blocks
  document.querySelectorAll("div.highlighter-rouge pre, figure.highlight pre").forEach(function (pre) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "copy-btn"; b.textContent = "複製";
    b.addEventListener("click", function () {
      navigator.clipboard && navigator.clipboard.writeText(pre.innerText).then(function () {
        b.textContent = "已複製"; setTimeout(function () { b.textContent = "複製"; }, 1500);
      });
    });
    pre.parentElement.style.position = "relative"; pre.parentElement.appendChild(b);
  });

  // Inline post figures so the SVG <style> can see html[data-theme].
  // An <img> SVG is a separate document: OS dark mode still works via
  // prefers-color-scheme, but the manual toggle does not. If fetch fails,
  // the original image stays (readable light palette).
  document.querySelectorAll(".post-content img").forEach(function (img, index) {
    var src = img.getAttribute("src") || "";
    if (src.indexOf("/assets/img/posts/") === -1 || !/\.svg([?#]|$)/i.test(src)) return;
    fetch(src).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }).then(function (text) {
      if (!img.isConnected) return;
      var parsed = new DOMParser().parseFromString(text, "image/svg+xml");
      if (!parsed || parsed.querySelector("parsererror")) return;
      var svg = parsed.documentElement;
      if (!svg || svg.localName !== "svg") return;
      var prefix = "fwfig" + index + "_";
      var ids = Object.create(null);
      svg.querySelectorAll("[id]").forEach(function (el) {
        var oldId = el.getAttribute("id");
        var newId = prefix + oldId;
        ids[oldId] = newId;
        el.setAttribute("id", newId);
      });
      var rewrite = function (value) {
        return value.replace(/url\(\s*#([^)]+?)\s*\)/g, function (_, id) {
          return "url(#" + (ids[id] || id) + ")";
        }).replace(/^#(.+)$/, function (_, id) {
          return "#" + (ids[id] || id);
        });
      };
      svg.querySelectorAll("*").forEach(function (el) {
        for (var i = 0; i < el.attributes.length; i++) {
          var attr = el.attributes[i];
          if (!attr.value || attr.value.indexOf("#") === -1) continue;
          var next = rewrite(attr.value);
          if (next !== attr.value) el.setAttribute(attr.name, next);
        }
      });
      svg.setAttribute("role", "img");
      if (img.alt) svg.setAttribute("aria-label", img.alt);
      img.replaceWith(svg);
    }).catch(function () {});
  });
})();
