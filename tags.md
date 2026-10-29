---
layout: page
title: 標籤
permalink: /tags/
---
{% assign tags = site.tags | sort %}
<p>{% for t in tags %}<a class="tag" href="#{{ t[0] | slugify: 'raw' }}">{{ t[0] }}（{{ t[1].size }}）</a>{% endfor %}</p>

{% for t in tags %}
<h2 id="{{ t[0] | slugify: 'raw' }}">{{ t[0] }}</h2>
<ul>{% for post in t[1] %}<li><a href="{{ post.url | relative_url }}">{{ post.title | escape }}</a> <span class="post-meta">{{ post.date | date: "%Y-%m-%d" }}</span></li>{% endfor %}</ul>
{% endfor %}
