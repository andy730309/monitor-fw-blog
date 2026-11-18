---
layout: post
title: "OSD 多語系與 CJK 字型子集化：為什麼切語言會出方塊字、背光卡住"
date: 2026-11-04
tags: [OSD, CJK, 多語系, 字型, MCCS, DDC/CI]
level: intermediate
prerequisites: ["OSD menu table-driven 架構與資源壓縮", "DDC/CI 與 MCCS 入門"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
difficulty: intermediate
---
## 前置知識

顯示器的 OSD（On-Screen Display，螢幕顯示選單）是韌體在畫面上疊加的選單與訊息，由 scaler FW 的 OSD 引擎渲染。OSD 字串（如「亮度」、「輸入源」、「語言」）原本常直接寫進 C 原始碼的 `.rodata`，編譯進 firmware image。多語系意味著同一個選單項目要有英文、德文、繁體中文、日文等多個版本，字串長度差異很大（德文常比英文長）。CJK（中文日文韓文）字型更佔空間：一個完整的 CJK Unified Ideographs 字元集動輒兩萬多個字元，直接打包會吃光 scaler 的 SRAM 與 flash。

DDC/CI（Display Data Channel Command Interface）是透過 I2C 從主機讀寫顯示器設定的協定，MCCS（Monitor Control Command Set）定義了 VCP（Virtual Control Panel）代碼。VCP 0xCC 是 OSD Language，VCP 0xCA 是 OSD/Button Control，這兩個代碼與語義已由 ddcutil 公開文件查證。MCCS 功能分為 Continuous、Non-continuous、Table 三類，Non-continuous 再分 simple 與 complex。

## 技術核心

### 字串表外部化

不要把 OSD 字串手寫進 `.rodata`。應該把所有語言的字串放進 CSV/XLS，由 build script 產生 C table，每個字串帶 `string_id`、`lang_id`、`str_len` 與 UTF-8 內容。這樣不同市場可以用不同字串表，不需要重刷整顆 FW 就能增補翻譯。Build 時要檢查每語言每字串的位元組數，德文/俄文長字串不得超過 OSD 項目框寬度，超過則 fallback 到英文，避免截斷或溢位。

### CJK 字型子集化

CJK 字型不能整包載入 SRAM。應該從當前語言的字串表掃描出實際出現的 Unicode codepoint，只載入這些 glyph 到 OSD SRAM tile，其餘不佔空間。glyph 數上限依實際 scaler SRAM 容量設定（此處 512 為架構示意，非晶片規格）。語言切換時，先卸載舊字型（釋放 SRAM tile 與 palette），再載入新語言的子集 glyph，避免 SRAM 碎片化與字型殘影。

### DDC/CI 與 OSD 語言同步

VCP 0xCC OSD Language 與 VCP 0xCA OSD/Button Control 的代碼與語義已依 ddcutil vcpinfo 公開文件查證（MCCS 2.0/2.1/3.0/2.2，Non-continuous simple）。主機透過 DDC/CI setvcp 改變 OSD 語言時，scaler FW 需把 VCP 值映射到內部 lang_id，重建字型子集，並重繪所有選單項目。這個映射關係（語言索引對應什麼 codepoint）依晶片 SDK，此處為示意，非公開規格。

### 示意程式碼（非晶片規格）

以下 C 片段中的暫存器地址與 Macro（如 `OSD_REG_FONT_CTRL`、`SCALER_REG_OSD_LANG`）均標註 `/* 示意地址，非實際晶片規格 */`，實際對接需依手上的 scaler NDA datasheet。DDC/CI VCP 代碼 0xCC、0xCA 已依 ddcutil 公開文件查證。

```c
/* 示意地址，非實際晶片規格 */
#define OSD_REG_FONT_CTRL   0xF000
#define SCALER_REG_OSD_LANG 0xF010

/* 已查證：VCP 0xCC = OSD Language（ddcutil vcpinfo，MCCS 規格） */
/* 示意：lang_id 映射與 scaler 暫存器寫入依晶片 SDK */
void ddc_ci_handle_setvcp(uint8_t vcp_code, const uint8_t *value, uint8_t len)
{
    if (vcp_code == 0xCC) {
        uint8_t new_lang = value[0];
        if (new_lang != g_osd_lang_id) {
            g_osd_lang_id = new_lang;
            osd_build_glyph_subset(new_lang);   /* CJK 字型子集化重建 */
            osd_menu_refresh_all();             /* 重繪選單 */
            *(volatile uint8_t *)SCALER_REG_OSD_LANG = new_lang;  /* 示意地址 */
        }
    }
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某機種出貨歐洲與東亞市場後，客訴集中在三點：(1) 選 OSD 語言為德文時，幾個選單項目顯示成方塊字或截斷一半；(2) 繁體中文 OSD 開啟後，背光 PWM 偶爾卡住、亮度無法調；(3) 從英文切回繁體中文，部分圖示與字型殘影不消失。FW 團隊檢查後發現，字串表與字型資料直接編進 scaler SRAM，CJK 字元集體積龐大，佔用 OSD 資源區近半；多語系切換時沒有正確卸載舊字型 glyph，導致 SRAM 碎片化與渲染任務餓死背光 PWM。修正後，字串表外部化、CJK 僅載實際用到的 glyph、語言切換前先 `osd_font_unload_all()`，三個症狀皆消失。

## 新人避坑指南

1. **不要把翻譯字串硬編碼在 C 原始碼**。多語系字串應外部化，build 時從 CSV 產生，否則每增一種語言都要重刷 FW，產線 takt 會受影響。
2. **CJK 字型不要整包載入**。整個 CJK 區塊會吃光 SRAM，必須做子集化，只載當前語言實際出現的 codepoint。
3. **語言切換要卸載舊字型**。不卸載舊 tile/palette 會造成 SRAM 碎片與字型殘影，使用者會以為螢幕壞了。
4. **OSD 渲染不要阻塞背光 PWM 與 DDC/CI**。字型 flash 讀取是大塊操作，放入低優先級 task，ISR 僅設旗標，否則亮度調節會卡住。
5. **DDC/CI 0xCC 與 0xCA 的代碼已公開查證**，但 scaler 端如何把 VCP 值映射到 lang_id 依晶片 SDK，不要把示意地址當真實規格寫進 release note。

## 思考題

如果一支顯示器要同時支援英文、德文、繁體中文、日文、阿拉伯文五種語言，OSD SRAM 預算只有 64 KB，字型採 16×16 像素 1 bpp，每個 glyph 佔 32 位元組，請問每種語言最多能載入多少個 glyph？CJK 與阿拉伯文（RTL，文字方向由右到左）在 OSD 渲染上還有什麼額外要注意的？

<details>
<summary>參考思考方向（不給標準答案）</summary>

64 KB / 32 位元組 = 2048 個 glyph 總上限，五種語言分攤平均約 400 個，但實際應依各語言字串表出現的 codepoint 數動態分配，不應平均切分。阿拉伯文是 RTL 語言，OSD 引擎需要支援文字方向反轉與字形連接（shaping），這與 CJK 的橫向排版不同，字型子集化與渲染管線都要分開處理。
</details>

## 參考資料

1. ddcutil 文件，vcpinfo 輸出範例（官方）：https://www.ddcutil.com/vcpinfo_output/ — 列出 VCP 0xCA OSD/Button Control、VCP 0xCC OSD Language 與 MCCS 版本支援。
2. ddcutil 文件，Monitor Control Command Set 背景（官方）：https://www.ddcutil.com/mccs_background/ — MCCS 版本（1.0/2.0/2.1/3.0/2.2）、VCP 功能類型（Continuous/Non-continuous/Table）、simple vs complex 區分。
3. Unicode.org CJK Unified Ideographs 碼表：嘗試抓取 https://www.unicode.org/charts/PDF/U4E00.pdf 與 https://www.unicode.org/charts/ 均回傳 500 錯誤，未取得內容，標「待查證」。
4. 各 scaler 廠商 OSD 字型引擎 datasheet：屬 NDA 文件，本地無公開規格庫，本文所有 `0xFxxx` 與 SRAM 地址均為 `/* 示意地址，非實際晶片規格 */`，實際對接需依手上的 NDA datasheet，標「待查證」。
