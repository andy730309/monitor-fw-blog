---
layout: default
title: 首頁
---
# 顯示器韌體開發教學

給想進入系統廠 / ODM 顯示器韌體領域的新人。依學習路線由淺入深（Foundations → Practitioner → Senior → Principal）。完整路線圖見 [學習路線]({{ '/roadmap/' | relative_url }})。

> 本站內容由 AI 輔助撰寫（Hermes Agent），可能有錯誤；每篇文章都附參考來源，標「（需查證）」處請以官方規格為準。

{% assign levels = "beginner,intermediate,advanced,expert" | split: "," %}
{% assign level_names = "入門,中階,進階,專家" | split: "," %}

## 最新文章

<ul class="series-list">
{%- for post in site.posts limit: 6 -%}
  <li><span class="sid">{{ post.date | date: "%m/%d" }}</span><span><a href="{{ post.url | relative_url }}">{{ post.title | escape }}</a>{% if post.series and post.series != "" %} <span class="post-meta">· {{ post.series }}</span>{% endif %}</span></li>
{%- endfor -%}
</ul>

依學習藍圖（Part 0～7）排好的完整目錄，包括還在規劃中的文章，請看 **[系列目錄]({{ '/series/' | relative_url }})**；依主題找文章請看 [標籤]({{ '/tags/' | relative_url }})。

## 依難度

{% for lv in levels %}
{% assign lp = site.posts | where: "difficulty", lv %}
{% if lp.size > 0 %}
### {{ level_names[forloop.index0] }}（{{ lv }}）
{% for post in lp %}
- [{{ post.title }}]({{ post.url | relative_url }}){% if post.series %} — {{ post.series }}{% endif %}
{% endfor %}
{% endif %}
{% endfor %}
{% assign others = "" | split: "" %}
{% for post in site.posts %}{% unless levels contains post.difficulty %}{% assign others = others | push: post %}{% endunless %}{% endfor %}
{% if others.size > 0 %}
### 其他
{% for post in others %}
- [{{ post.title }}]({{ post.url | relative_url }}){% if post.difficulty %} · `{{ post.difficulty }}`{% endif %}
{% endfor %}
{% endif %}
