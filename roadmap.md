---
layout: page
title: 學習路線
permalink: /roadmap/
---

> 給想進入系統廠 / ODM 顯示器韌體領域的新人。依學習路線由淺入深排列（Foundations → Practitioner → Senior → Principal）。
> 每篇文章由 Hermes 研究回合自動撰寫，皆附參考來源；標「（需查證）」處請以官方規格為準。

## Stage 1 — Foundations（基礎）
### 系列 A：顯示器是怎麼運作的
- [顯示器系統方塊圖入門：Scaler、T-CON、Panel、Backlight、PD、Hub 是怎麼分工的？]({{ site.baseurl }}{% post_url 2026-10-29-monitor-system-block-diagram %}) — beginner — 六大子系統分工、訊號/電源/控制三條路徑、USB-C PD 與 Alt Mode 架構
- [顯示器韌體工程師在系統廠/ODM 的角色與一天的工作]({{ site.baseurl }}{% post_url 2026-10-29-monitor-fw-engineer-role-odm %}) — beginner — 系統廠/ODM 韌體工程師職責全景、EVT→DVT→PVT→MP 四階段典型工作、與 IC 設計廠差異、常見陷阱與動手練習
- [色彩入門：RGB、Gamma、色溫、色域 (sRGB/DCI-P3/Adobe RGB)]({{ site.baseurl }}{% post_url 2026-10-29-color-basics-rgb-gamma-cct-gamut %}) — beginner — 四大色彩基石、sRGB 分段 EOTF vs 純 2.2、DCI-P3/Display P3/Adobe RGB 三大色域比較、CCT 與 xy 白點的關係、常見陷阱與動手練習
- [影像介面總覽：VGA / DVI / HDMI / DisplayPort / USB-C 的差異與演進]({{ site.baseurl }}{% post_url 2026-10-29-video-interface-overview %}) — beginner — 五大介面演進時間軸、TMDS/FRL/UHBR 編碼頻寬計算、USB-C Pin Assignment C/D/E、DP++ 與 Alt Mode 相容性陷阱、韌體三條路徑
### 系列 B：嵌入式韌體基礎
- [DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器]({{ site.baseurl }}{% post_url 2026-10-28-ddc-ci-mccs-ddcutil-intro %}) — beginner — 學會用 ddcutil 讀寫亮度/色溫/輸入源，理解 EDID 0x50 與 DDC/CI 0x37
- [EDID 入門：用 edid-decode 解析顯示器身分證]({{ site.baseurl }}{% post_url 2026-10-29-edid-intro-edid-decode %}) — beginner — EDID Base Block 128 bytes 逐欄位拆解、DTD 18-byte 手算刷新率、CTA-861 Extension Block 與 HDR/VRR 宣告、edid-decode 實戰指令

## Stage 2 — Practitioner（獨立作業）
### 系列 C：影像介面入門（DP / HDMI / Type-C / VGA / EDID）
- [DPCD 入門：DisplayPort 設定資料結構與 Sink Capability 宣告]({{ site.baseurl }}{% post_url 2026-10-29-dpcd-sink-capability %}) — beginner — DPCD 位址空間架構、Receiver Capability 16 bytes 逐欄位解析、Extended Receiver Capability (HBR3/UHBR)、Link Config/Status 搭配 Link Training 流程、常見陷阱與 AUX analyzer 實戰練習
- [DSC 開下去畫面綠條亂竄？4K144 螢幕 sink 端 DSC 參數宣告與 PPS 驗證的坑]({{ site.baseurl }}{% post_url 2026-10-29-dsc-sink-params-slice-bpp-buffer-model %}) — intermediate — DPCD DSC capability（slice/throughput/max slice width）宣告收斂、PPS 128 bytes 與 chunk_size 的 Q4.4 分數 bpp 驗證、HRD buffer model 概念、多廠 GPU 驗證矩陣
### 系列 D：色彩與畫質入門
### 系列 E：OSD 與使用者體驗

## Stage 3 — Senior（帶領與攻堅）
### 系列 F：進階介面與認證
### 系列 G：自動化測試與品質
### 系列 H：產線與客訴

## Stage 4 — Principal（架構與策略）
### 系列 I：平台架構、選型與專案領導
