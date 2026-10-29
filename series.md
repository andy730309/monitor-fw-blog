---
layout: page
title: 系列目錄
permalink: /series/
---
依學習藍圖分成 8 個 Part。已發佈的文章有連結；標「規劃中」的還沒寫。

{% assign total = 0 %}{% assign done = 0 %}
{% for part in site.data.blueprint %}{% for it in part.items %}{% assign total = total | plus: 1 %}{% if it.post != "" %}{% assign done = done | plus: 1 %}{% endif %}{% endfor %}{% endfor %}
<p class="post-meta">進度：已發佈 {{ done }} / 規劃 {{ total }} 篇</p>

{% for part in site.data.blueprint %}
{%- assign pd = part.items | where_exp: "i", "i.post != ''" -%}
<section class="part" id="{{ part.part | slugify }}">
<h2>{{ part.part }}　{{ part.title }}<span class="part-progress">{{ pd.size }} / {{ part.items.size }}</span></h2>
<ul class="series-list">
{%- for it in part.items -%}
  {%- assign p = nil -%}
  {%- if it.post != "" -%}{%- assign p = site.posts | where: "slug", it.post | first -%}{%- endif -%}
  <li><span class="sid">{{ it.id }}</span>
  {%- if p -%}
    <span><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></span><span class="status done">已發佈</span>
  {%- else -%}
    <span class="planned" title="{{ it.goal | escape }}">{{ it.title | escape }}</span><span class="status plan">規劃中</span>
  {%- endif -%}
  </li>
{%- endfor -%}
</ul>
</section>
{% endfor %}
