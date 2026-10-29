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
})();
