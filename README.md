# 顯示器韌體開發教學部落格

給想進入系統廠 / ODM 顯示器韌體領域新人的中文教學部落格，依學習路線由淺入深（Foundations → Practitioner → Senior → Principal）。

- 網站：<https://andy730309.github.io/monitor-fw-blog/>
- 以 GitHub Pages 原生 Jekyll（minima 主題）建置，不需要自訂 build。

## 注意事項

- **本站內容為 AI 輔助撰寫**（使用 Hermes Agent 研究與撰寫），**可能含有錯誤或過時資訊**。
- **每篇文章文末皆列出參考來源**；標示「（需查證）」之處請以官方規格（VESA、HDMI Forum、USB-IF 等）為準。
- 目前的《DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器》是**手動撰寫的範例文章**：由安裝流程以公開來源撰寫（非 Hermes 研究回合產出），作為之後文章的格式範本。

## 目錄結構

| 路徑 | 說明 |
| --- | --- |
| `_config.yml` | 站台設定（標題、語系 zh-TW、時區 Asia/Taipei） |
| `_posts/` | 文章，檔名 `YYYY-MM-DD-slug.md`，由同步腳本自動產生 |
| `index.md` | 首頁：依系列與難度列出文章 |
| `roadmap.md` | 學習路線（由 Hermes 的 `index.md` 轉換） |
| `_layouts/`、`_includes/` | 文章版面與 mermaid 圖表渲染 |

## 更新方式

文章原稿在 Hermes 端 `~/.hermes/blog/posts/`，以 `~/.hermes/bin/monitor-fw-blog-publish.sh` 轉換並推送；請勿直接編輯 `_posts/`（會被覆蓋）。

文章 front matter 欄位：`title`、`date`、`tags`、`difficulty`（beginner / intermediate / advanced / expert）、`prerequisites`、`series`。
