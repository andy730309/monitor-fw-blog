---
layout: post
title: "暗場字幕一圈光暈？Mini-LED local dimming 的 duty 演算法與 halo/blooming 抑制"
date: 2026-11-02
tags: [local dimming, Mini-LED, FALD, halo, blooming, DisplayHDR, backlight, HDR]
level: intermediate
prerequisites: ["顯示器系統方塊圖入門（posts/2026-10-29-monitor-system-block-diagram.md）", "DisplayHDR 送測三連爆：Active Dimming、Subtitle Flicker、Static Contrast 的韌體端根因（posts/2026-11-01-displayhdr-cts-1-2-test-items-vesa-tool.md）"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-02
description: "Mini-LED 暗場字幕出現光暈，多半是韌體背光 duty 算錯、LCD 端沒補償。本文拆解 zone duty 演算法與 halo 抑制。"
seo_title: "Mini-LED 暗場光暈：local dimming duty 演算法"
difficulty: intermediate
---
> **重點摘要**：Local dimming 的 halo 大多是韌體把背光 duty 算錯、LCD 端又沒補償造成，不一定是面板漏光。zone duty 不要只取最大值，亮區要考慮 BLU 的光學擴散外擴，duty 拉亮幾倍，LCD 像素就要除以幾倍。時間平滑與提交時序則決定字幕會不會閃爍。

暗場電影看到字幕周圍一圈灰光、亮物體旁邊整片霧掉，十個新人九個第一句話是「面板漏光，換面板」。錯。Local dimming 的 halo 大部分是韌體把背光 duty 算錯、LCD 端又沒補償造成的。這篇把 duty 演算法從統計、平滑到提交時序整條拆開，講清楚每一層該擋什麼。

## 前置知識

先把背光架構講白。LCD 自己不發光，光從背後的 LED 來。VESA 在 DisplayHDR 官方解說文裡把調光設計分成幾種：

- **Global dimming**：整片背光當一個 zone 一起調，成本最低，同時對比永遠不超過面板原生對比（通常約 1000:1，VESA 原文數字）。
- **1D local dimming**：edge-lit，LED 串分 8 到 16 組獨立控制，同時對比 6,000:1 到 100,000:1。
- **1.5D**：上下兩邊各一條，約 2×16 zones，上下獨立。
- **2D / FALD（full array local dimming）**：LED 排在面板後方的二維矩陣，現今 HDR 顯示器與電視通常 384 到 1152 zones，同時對比 20,000:1 到 500,000:1。

工程類比：FALD 就像一塊分成上千格的調光檯燈陣列，每格有自己的亮度旋鈕。你的工作是看著畫面內容，每秒 60 次決定每個旋鈕轉到幾號，還要保證「旋鈕轉亮的地方，LCD 那格的窗簾要相對拉窄」，不然那格就過亮。

兩個名詞先定義：

- **Halo**：暗背景裡的亮物體周圍出現一圈光暈。來源有兩層：背光 duty 對相鄰 zone 的光學擴散，加上液晶 off-state 的漏光（light leakage，LL）。SID 的一篇模擬論文講得很直白：halo 是「被調暗的背光單元」加上「LC 面板非理想 off-state」共同造成的，而且永遠不可能完全消除，只能在成本（LED 數量）與感知之間取捨。
- **Blooming**：亮部亮度被放大超過目標，往周圍暈開過曝。多半是 duty 拉亮之後 LCD 端沒做反向補償。

還有一個反直覺的事實：人眼自己也有 halo。亮點旁的暗區，視網膜散射會讓你「看到」光暈。所以調校的終點不是零光暈，而是讓背光造成的 halo 低於人眼自己的 halo——SID 論文的模擬驗證就是用這個思路做的。

## 技術核心

### Zone duty 怎麼算：別用純 max

最直覺的寫法是每個 zone 取內部像素的最大亮度當 duty。暗場裡一顆亮字幕像素落在某 zone，整個 zone 的背光就被拉滿，字幕周圍一圈全被照亮，halo 就這麼來的。

修正：percentile 與 max 加權混合。大面積亮部（DisplayHDR 的 8% center patch 測項）靠 max 保峰值，暗場小亮點靠高 percentile（例如 P97）壓下來：

```c
/* zone 統計：0.75*p97 + 0.25*max（示意調校值，依面板 halo 實測收斂） */
static uint16_t zone_stat(const uint16_t *luma, uint32_t n, uint32_t hist_max)
{
    uint32_t p97 = percentile_97(luma, n);      /* 直方圖法，示意 */
    uint32_t v   = (p97 * 3u + hist_max * 1u) / 4u;
    return (v > 255u) ? 255u : (uint16_t)v;     /* DisplayHDR CTS 1.2 要求背光控制 8-bit 精度 */
}
```

注意那個 255：DisplayHDR CTS 1.2 對 LCD tier 明訂「Backlight Control 8-bit Accuracy」。你的 duty 鏈路從演算法、shadow table 到 backlight driver 的 PWM，任何一段只有 4-bit 粒度，調校就是白做工。

### 亮 zone 外擴：先補 BLU 的光學擴散

背光不是點光源，一個 zone 打亮會往相鄰 zone 擴散。如果只把亮 zone 的 duty 給滿、相鄰 zone 給 0，亮物體邊緣會被相鄰暗 zone「拖黑」，看起來像描了黑邊。修正是把亮 zone 的 duty 用一個衰減核外擋到鄰居：

```c
/* 3x3 卷積：中心 1.0、四鄰 0.25、對角 0.125，之後 clamp（核係數示意，依 BLU PSF 實測調校） */
convolve3x3_clamp(raw_duty, ZONES_X, ZONES_Y);   /* 示意實作 */
```

核的形狀應該量測 BLU 的點擴散函數（PSF）來定，不是拍腦袋。

### LCD 反向補償：duty 拉亮幾倍，像素就除以幾倍

這是 blooming 的解。zone duty 提升 B 倍時，通過該 zone 的像素在線性域除以 B，亮度才會回到目標值：

```c
/* 線性域補償；gamma 域做會重演 uniformity 補償的 banding 老坑 */
static void lcd_compensate(uint16_t *pix_linear, uint32_t n, uint16_t duty, uint16_t duty_ref)
{
    if (duty <= duty_ref) return;                 /* 只補被拉亮的 zone */
    uint32_t inv_q15 = ((uint32_t)duty_ref << 15) / duty;   /* 1/B，Q1.15 */
    for (uint32_t i = 0; i < n; i++) {
        uint32_t v = ((uint32_t)pix_linear[i] * inv_q15) >> 15;
        pix_linear[i] = (v > 4095u) ? 4095u : (uint16_t)v;
    }
}
```

除法用倒數乘法（Q1.15 近似）是為了不逐像素做除法拖垮 pipeline 頻寬。

### 時間平滑與提交時序：Subtitle Flicker 的兩個解

字幕出現/消失那一幀，duty 如果直變，背光亮度階跳，肉眼直接看到呼吸。兩件事要做：

1. **快攻慢收的時間平滑**：亮部出現要快（不然亮部第一幀過暗），退暗要慢（字幕消失不階跳）。
2. **duty 表與 LCD gain 表同一 vblank 提交**：兩張表分開生效會出現「新 duty 配舊 gain」的過渡幀，量測儀器抓到的就是這個瞬態。

```c
/* 快攻慢收：attack >>3（快）、decay >>6（慢），示意起點 */
static uint16_t smooth(uint16_t prev, uint16_t target)
{
    uint16_t d    = (target > prev) ? (uint16_t)(target - prev) : (uint16_t)(prev - target);
    uint16_t step = (target > prev) ? (uint16_t)(d >> 3) : (uint16_t)(d >> 6);
    if (step == 0u) step = 1u;   /* 保證收斂 */
    return (target > prev) ? (uint16_t)((prev + step > target) ? target : prev + step)
                           : (uint16_t)((prev - step < target) ? target : prev - step);
}

/* 提交：兩張表先寫 shadow，單一 commit 於同一 vblank 交換 */
/* REG_LD_COMMIT 等暫存器為示意地址，非實際晶片規格 */
bld_write_shadow_table(new_duty);        /* 示意地址，非實際晶片規格 */
lcdcomp_write_shadow_table(new_duty, old_duty);  /* 示意地址，非實際晶片規格 */
REG_LD_COMMIT = 0x01u;                   /* 兩張表同一 vblank 同步生效 */
```

### 分區數在選型期就決定了一半

韌體再厲害也變不出分區。一篇 mini-LED HDR LCD 的期刊論文用 LabPSNR 量測人眼對 halo 的感知門檻（約 47.4 dB），據此給出分區數需求：面板原生對比 5000:1 以上的 MVA 面板，200 個 local dimming zones 起跳；對比 2000:1 以下的 FFS 面板，要 3000 個 zones 以上（原文符號為 ≥/≤，依 PDF 字型對應與上下文判讀）。換句話說，低對比面板配少分區，halo 是物理上壓不住的，調校只是在延命。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

一台 1152-zone FALD Mini-LED 機種（DisplayHDR 1000 目標），DVT 預測試三個症狀一起爆：

- **客訴（模擬）**：暗場電影字幕周圍一圈灰光暈，客戶端驗收直接開單。
- **Active Dimming fail**：CTS 1.2 對 1000 級要求 50 cd/m² checkerboard 白黑比 13 stops、5 cd/m² checkerboard 14 stops（VESA Performance Criteria 頁公開數字）；實測只有 11.x stops。
- **Subtitle Flicker 邊緣 fail**：1000 級門檻是字幕開關時 patch 亮度差上限 10%；實測 15% 上下抖動。

量測現象很有鑑別度：靜態 checkerboard 下黑格中心漏光遠超過 1000 級 Dual Corner Box 的 0.05 cd/m² 上限；把 local dimming 關掉，黑格乾淨了，但對比掉回面板原生值。這說明問題不在面板，在「duty 給太多＋LCD 沒補償」。

協定層與管線層分析對應四個根因：zone 統計用純 max（RC1）、LCD 端無反向補償（RC2）、duty 逐幀直變無平滑（RC3）、duty 表與 LCD gain 表不同步提交（RC4）。四個都修完之後，模擬平台實測 Active Dimming 回到 13.2 stops、Subtitle Flicker 壓到 8%（推演值，僅供調校方向參考），Dual Corner Box 黑格中心回到門檻內。

順帶一提，VESA 在 CTS v1.1 就加了 Active Dimming 測項，明講目的是驗證「顯示器真的在依畫面內容即時調背光」，而不是只在 metadata 變動時動一下——測法是在不改 metadata 的前提下，從全白 checkerboard 換到白格只有 5 cd/m² 的 checkerboard，看背光有沒有跟著大幅降功率。把 dimming 綁在 metadata 上而不是 per-frame 內容上的韌體，這一項必死。

## 新人避坑指南

看懂三條關鍵路徑，你就能自己診斷 halo 類問題：

1. **資料路徑**：輸入幀 → 降取樣亮度（線性域）→ zone 統計 → 外擴 → 時間平滑 → duty shadow table → backlight driver。任何一段用 gamma 域的值，補償就會錯。
2. **補償路徑**：duty 提升 → LCD 像素除以 boost。這條路徑斷了就是 blooming，量測特徵是亮部過曝且範圍比原圖大。
3. **提交路徑**：duty 表與 LCD gain 表必須同一 vblank 交換。這條路徑斷了就是 flicker，量測特徵是靜態畫面亮度抖動。

未來寫 code 或驗證時：

- duty 鏈路全段確認 8-bit 以上精度（CTS 1.2 明訂需求，別自己發明 4-bit 省暫存器）。
- zone 統計永遠不要用純 max；percentile 混合比例是 per-SKU 調校項，寫進 tuning table 而不是 hardcode。
- 平滑的 attack/decay 移位量、外擴核係數，全部做成可調參數並綁 build/serial 追溯，量產前用 CTS 測項當驗收關卡，不要靠肉眼。
- 選型期就把「面板原生對比 × 分區數」對照公開研究的門檻（MVA 5000:1 級 200 zones 起、FFS 2000:1 級 3000 zones 起）過一遍，別讓 halo 問題在 DVT 才第一次被認真看。
- 記住 halo 無解論：BLU 擴散、LC 漏光、人眼散射三層都在，目標是壓到人眼門檻以下，不是消滅。

## 思考題

DisplayHDR CTS 1.2 的 Active Dimming 測項用「50 cd/m² checkerboard」與「5 cd/m² checkerboard」兩張圖各量一組 stops，1000 級的門檻分別是 13 與 14 stops。問題：為什麼白格只有 5 cd/m² 的那張圖，要求的 stops 反而更多？提示：stops 是以 2 為底的對數，去查 VESA Performance Criteria 頁的 Active Dimming 定義段落，想清楚「分母變小、分子不變」時對數比值怎麼變。

<details>
<summary>參考方向（先自己想）</summary>
黑格亮度由背光降功率的程度決定。白格亮度上限不變（峰值亮度能力），白格只有 5 cd/m² 時給了 dimming 演算法更大的降功率空間，黑格可以壓得更低，白黑比值因此更大，換算成 stops 自然更高。這也是為什麼這個測項能直接分辨「dimming 綁 metadata」與「dimming 依內容」兩種韌體。
</details>

## 參考資料

1. VESA DisplayHDR Performance Criteria（CTS 1.2 摘要表，CTS 1.2 於 2024-05-07 釋出；Active Dimming stops、Subtitle Flicker、Static Contrast、Backlight Control 8-bit Accuracy 等門檻）— 官方：https://displayhdr.org/performance-criteria/
2. VESA DisplayHDR「LCD Dimming in HDR Displays Explained」（global/1D/1.5D/2D/active-dimming 定義、zone 數與對比範圍、Active Dimming 測項設計理念）— 官方：https://displayhdr.org/lcd-dimming-in-hdr-displays-explained/
3. Julian Ritter, Ramazan Ayasli, Till Mertin, Salvatore Grande, Chihao Xu，「Numerical Simulation of Halo Artifact Caused by Local-Dimming and its Validation on AMOLED Displays」，SID Symposium Digest 50-3（Saarland University / Tianma Europe）— 非官方（收錄於 SID 官網）：https://sid.org/Portals/sid/Files/SID-Digest/docs/50-3.pdf
4. 「High dynamic range liquid crystal displays with a mini-LED backlight」，Journal of the Society for Information Display（作者與年份欄位待查證；LabPSNR 約 47.4 dB 人眼感知門檻與分區數需求出自該 PDF 結論段）— 非官方（Semantic Scholar 公開 PDF）：https://pdfs.semanticscholar.org/c17a/6ee3eb4a77d3fd87c64d90443e0bc2e5c7fc.pdf

提醒：scaler 端 local dimming 引擎的暫存器介面與 backlight driver 行為多屬 NDA 文件，本文程式碼僅依公開規格推演示意，實作請對照你手上的 vendor SDK 與 driver datasheet。
