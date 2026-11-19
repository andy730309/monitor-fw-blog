---
layout: post
title: "sRGB 模式鎖色域鎖出一堆客訴？gamut clamp 做錯域、hard clip 與 soft mapping 的取捨"
date: 2026-11-17
tags: [gamut mapping, sRGB, BT.709, BT.2020, 3D LUT, clamp, OOG]
level: intermediate
prerequisites: ["3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因", "色彩入門：RGB、gamma、色溫、色域"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-17
description: "廣色域螢幕的 sRGB 模式飽和紅偏橘、膚色死灰？問題常在 gamut clamp 做錯域或方法。本文比較 hard clip 與 soft mapping。"
seo_title: "sRGB 模式鎖色域：hard clip 與 soft mapping"
difficulty: intermediate
---
> **重點摘要**：sRGB 模式的飽和紅偏橘、膚色死灰，多半不是面板或校正的問題，而是 gamut clamp 做錯了域或方法。clamp 只能在線性域進行；hard clip 數學上合法，視覺上卻會出問題，soft mapping 則往白點方向壓縮。量產時 3D LUT 是正解，矩陣只是備案。

廣色域螢幕的 sRGB 模式，是色彩驗證最容易翻車、也最容易出客訴的一個模式。翻車的樣子很固定：飽和紅偏橘、膚色死灰、高飽和色細節糊成一團。這篇把根因拆開：大部分不是 panel 爛，也不是校正沒做好，而是 gamut clamp 這一步做錯了域、或做錯了方法。

## 前置知識

先把三個名詞講清楚。

**色域（gamut）**：一個設備能顯示的顏色範圍。sRGB 模式要「鎖」的目標色域，用的是 ITU-R BT.709 reference primaries：紅（x=0.6400, y=0.3300）、綠（x=0.3000, y=0.6000）、藍（x=0.1500, y=0.0600）、白點 D65（x=0.3127, y=0.3290）。這組數字出自 W3C 託管的 sRGB 提案文件 Table 0.2，文件裡明寫這些就是 ITU-R BT.709 reference primaries。而廣色域 HDR 內容的基準是 ITU-R BT.2020 primaries：紅（x=0.708, y=0.292）、綠（x=0.170, y=0.797）、藍（x=0.131, y=0.046）、白點同樣是 D65，出自 Rec. ITU-R BT.2020-2 的 Table 3。BT.2020 的三角形比 BT.709 大很多，所以一台原生色域接近 BT.2020 或 DCI-P3 的螢幕，要顯示 sRGB 內容時，得把超出的顏色「收」進來。

**OOG（out-of-gamut）**：目標色域裝不下的顏色。把廣色域的顏色用矩陣轉到 BT.709 座標系時，超出來的顏色會變成負值或大於 1.0 的三刺激值。負值與大於 1.00 的值通常不保留，編碼軟體不支援 extended range 時，就用 simple clipping 限制在 0.0 到 1.0 之間[^1]。這句話是所有 gamut clamp 的起點，但注意，它描述的是「數學上合法」，不是「視覺上最好」。

**工程類比**：把大水庫的水倒進小水庫，超出容量的水有兩種處理法。第一種是直接把滿出來的水切掉（hard clip），水位永遠不會超過壩頂，但切掉的水去哪了？消失了，而且壩頂附近一大片水面全部被壓成同一個高度。第二種是把整片水面等比例往下壓（soft mapping），每個位置的高度關係還在，只是整體矮一點。顯示器裡，第一種做法就是「高飽和色糊成一團」，第二種就是 gamut mapping。

## 技術核心

### Pipeline 位置決定一切：clamp 只能做在線性域

scaler 的典型影像處理順序是：input CSC（YCbCr 轉 RGB）→ de-gamma（線性化）→ gamut 轉換（3x3 矩陣或 3D LUT）→ gamma 再編碼（1D LUT）→ panel 補償 → dithering。gamut 轉換與 OOG 處理必須放在 de-gamma 之後、gamma 再編碼之前的線性域。

為什麼？3x3 矩陣是在混合三刺激值，三刺激值是線性的量；gamma 編碼值與線性值不是線性對應。舉例：sRGB 編碼值 0.9，換算回線性域約是 0.787（依 sRGB EOTF 公式計算，calc/gamut.txt）。把矩陣直接套在 gamma 編碼的 R'G'B' 上，混出來的比例就錯了，而且錯的程度隨訊號大小改變，同一個色相在 100% 和 75% 飽和時會落在不同位置。soft mapping 這類「按比例往灰色壓」的運算也一樣，要在線性域做。

要注意一個細節：單純把每個通道 clip 到 0 與 1，在編碼域或線性域做結果相同，因為 EOTF 把 0 對到 0、1 對到 1，而且單調遞增。所以色相偏的主因是「矩陣或混合運算做在編碼域」，不是「clip 的量被 gamma 放大」。

### hard clip 的數學合法與視覺災難

先釐清 OOG 什麼時候才會出現。sRGB 模式的輸入是 sRGB 訊號，要轉成面板 native RGB。只要面板色域完整包住 sRGB，sRGB→native 的矩陣係數都不是負數，輸出一定落在 0 到 1 之間：以 P3-D65 與 BT.2020 primaries 驗算，八個色塊角點全部在範圍內（calc/gamut.txt）。OOG 只會在兩種情況出現：一是輸入比 sRGB 寬（例如 sRGB 模式下收到 BT.2020／P3 訊號，要轉到 BT.709，矩陣有負係數）；二是面板實測 primaries 沒有完整包住 sRGB（例如某一個角落差一點）。

在這兩種情況下，矩陣轉完會出現負值或大於 1.0 的值。直接 clip 到 0 與 1，數學上完全合法，sRGB 文件也是這樣描述的。問題在視覺：

- 一整片超出色域的高飽和色，clip 之後全部變成同一個輸出值，細節直接消失。
- 每個通道各自 clip，會改變三通道的比例，飽和紅、橘這類靠近邊界的顏色色相會偏。膚色多半在 BT.709 內，不會被 clip；如果 sRGB 模式的膚色看起來死灰，先查矩陣是不是做在 gamma 編碼域、白點對不對，或面板實測 primaries 有沒有包住 sRGB。

### soft mapping：往白點方向壓縮

取代純 clip 的常見思路（個人經驗推論的簡化版，非標準明訂演算法）：OOG 像素不切掉，而是保持亮度 Y，往同亮度的灰色（Y, Y, Y）壓縮飽和度，剛好壓回 0 到 1 為止，色相大致保住。示意程式碼如下，暫存器地址與 Macro 皆為示意：

```c
/* ============================================================
 * sRGB 模式 gamut clamp / mapping（示意碼）
 * 暫存器地址、Macro 名稱皆為示意，非實際晶片規格。
 * 色域常數來源：
 *   - BT.709 primaries / D65：W3C sRGB 文件 Table 0.2（Rec. ITU-R BT.709-6）
 *   - BT.2020 primaries / D65：Rec. ITU-R BT.2020-2 Table 3
 * ============================================================ */
#include <stdint.h>

/* 示意地址，非實際晶片規格 */
#define REG_GAMUT_MODE_SEL        0x1A2C0000u  /* 0: native, 1: sRGB(BT.709), 2: DCI-P3 */
#define REG_GAMUT_LUT_BANK_SEL    0x1A2C0004u  /* 0: bank A, 1: bank B（雙 bank 防撕裂） */
#define REG_GAMUT_LUT_COMMIT      0x1A2C0008u  /* 寫 1 於 vblank 生效，單一 commit 出口 */
#define REG_GAMUT_OOG_MODE        0x1A2C000Cu  /* 0: hard clip, 1: desat-toward-gray */

typedef struct { double x, y; } chroma_t;

/* Rec. ITU-R BT.2020-2 Table 3（官方數值）：離線產生矩陣時使用 */
const chroma_t BT2020_R = { 0.708, 0.292 };
const chroma_t BT2020_G = { 0.170, 0.797 };
const chroma_t BT2020_B = { 0.131, 0.046 };

/* W3C sRGB 文件 Table 0.2：ITU-R BT.709 reference primaries（官方數值） */
const chroma_t BT709_R  = { 0.6400, 0.3300 };
const chroma_t BT709_G  = { 0.3000, 0.6000 };
const chroma_t BT709_B  = { 0.1500, 0.0600 };
const chroma_t D65      = { 0.3127, 0.3290 };

/* BT.709 線性 RGB 的亮度係數（由上面 primaries 與 D65 推導，計算見 calc/gamut.txt） */
#define LUMA_R 0.2126
#define LUMA_G 0.7152
#define LUMA_B 0.0722

/* 輸入端→BT.709 的 3x3 矩陣由校正資料產生器離線計算後燒入，
 * 矩陣係數屬 per-panel 校正資料，非公開規格。 */
extern void Scaler_Load_Gamut_Matrix(const double m[3][3]); /* 示意 Macro，非實際晶片規格 */
extern void Scaler_Write_Register_Byte(uint32_t addr, uint8_t val); /* 示意 */

/* 線性域 OOG 處理：超界時保持亮度 Y，往同亮度的灰（Y, Y, Y）壓縮飽和度，
 * 剛好壓回 [0, 1] 為止；最後才 clip。
 * 簡化版，完整做法應沿 gamut 邊界做最小色差映射。 */
void gamut_map_oog(double rgb[3], int soft_enable)
{
    int i;
    double max_c = rgb[0], min_c = rgb[0];
    double y, k = 1.0;

    for (i = 1; i < 3; i++) {
        if (rgb[i] > max_c) max_c = rgb[i];
        if (rgb[i] < min_c) min_c = rgb[i];
    }
    if (max_c <= 1.0 && min_c >= 0.0) return;

    if (soft_enable) {
        y = LUMA_R * rgb[0] + LUMA_G * rgb[1] + LUMA_B * rgb[2];
        if (y < 0.0) y = 0.0;                   /* 亮度本身超界時只能退回 clip */
        if (y > 1.0) y = 1.0;
        if (max_c > 1.0 && max_c > y) {
            double kk = (1.0 - y) / (max_c - y);
            if (kk < k) k = kk;
        }
        if (min_c < 0.0 && y > min_c) {
            double kk = y / (y - min_c);
            if (kk < k) k = kk;
        }
        for (i = 0; i < 3; i++)
            rgb[i] = y + k * (rgb[i] - y);
    }
    /* hard clip（sRGB 文件描述的 simple clipping），soft 模式下只吃浮點誤差 */
    for (i = 0; i < 3; i++) {
        if (rgb[i] < 0.0) rgb[i] = 0.0;
        if (rgb[i] > 1.0) rgb[i] = 1.0;
    }
}

/* sRGB 模式進入流程：切 LUT bank → 設 OOG 模式 → vblank commit */
void Gamut_Enter_Srgb_Mode(void)
{
    Scaler_Write_Register_Byte(REG_GAMUT_LUT_BANK_SEL, 0x01); /* 示意地址，非實際晶片規格 */
    Scaler_Write_Register_Byte(REG_GAMUT_OOG_MODE,    0x01);  /* 示意地址，非實際晶片規格 */
    Scaler_Write_Register_Byte(REG_GAMUT_MODE_SEL,    0x01);  /* 示意地址，非實際晶片規格 */
    Scaler_Write_Register_Byte(REG_GAMUT_LUT_COMMIT,  0x01);  /* 示意地址，非實際晶片規格 */
}
```

這段碼裡已查證與示意的界線要分清楚：BT.709／BT.2020 primaries 與 D65 色度座標是官方規格數值；`REG_GAMUT_*` 全部是示意地址，實際晶片的 LUT 載入與 commit 機制請對照你手上的晶片 SDK（多屬 NDA 範圍）。soft mapping 的權重公式是簡化版，不是任何標準的規定；ICC v4 的 perceptual intent 只定義語意不綁演算法，實作選型是工程判斷。

### 量產現實：3D LUT 才是正解，矩陣是 fallback

3x3 矩陣是線性變換，修不了 panel 的非線性 crosstalk。sRGB 模式要鎖色域鎖得準，正規做法是把 native→sRGB 的映射（含 OOG 處理）離線烘進 3D LUT，矩陣只當粗修或 LUT CRC 驗證失敗時的 fallback。量產上還要注意：矩陣係數來自 per-panel 校正資料，不能用理論 primaries 硬套，因為 panel 實測 primary 與規格值有偏差。

### HDR 模式別混進來

HDR 的 tone mapping 是另一條路，亮度錨點用 Report ITU-R BT.2408-8 定義的 HDR Reference White：203 cd/m²（PQ 顯示器上，或峰值 1000 cd/m² 的 HLG 顯示器上），對應 58%PQ／75%HLG。同一份文件 Table 4 給了不同峰值 HLG 顯示器的 reference white 亮度：峰值 400 對應 101、600 對應 138、800 對應 172、1000 對應 203、1500 對應 276、2000 對應 343 cd/m²。SDR sRGB 模式的 LUT 與 HDR 模式分開保存，切換走雙 bank＋vblank 單一 commit，別讓兩套色彩處理互相汙染。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠廣色域機種（native gamut 約 DCI-P3 等級）進入 DVT，色彩驗證回報：sRGB 模式量 24 色卡，平均 ΔE00 還過得去，但飽和紅與飽和綠兩格的最大值爆表，高飽和區出現色相偏移。同時模擬客訴進來：攝影師使用者切 sRGB 模式修圖，膚色死灰、鮮紅招牌變磚紅，客訴理由寫「sRGB 模式比 Native 難看」。

量測現象：訊號產生器打 100% 飽和紅與 75% 飽和紅，sRGB 模式下兩者的色度座標不一致；切回 Native 模式則一致。另外，播放 HDR／BT.2020 片源時，sRGB 模式下高飽和區整片糊掉。EDID、timing、quantization range 全部正常，問題鎖定 scaler 內部。

協定層與 pipeline 分析找到兩個疊加的根因：第一，sRGB→native 矩陣直接套在 gamma 編碼的 R'G'B' 上，沒有先 de-gamma，混色比例隨訊號大小改變，所以 100% 與 75% 的紅落在不同色度；第二，廣色域片源轉到 BT.709 時，OOG 像素一律 hard clip，高飽和色整片被壓成同一輸出值。修正方向就是把 gamut 轉換與 OOG 處理全部移到線性域，OOG 改 soft mapping 並保留 clip fallback，模式切換改雙 bank LUT＋vblank 單一 commit。複驗時飽和紅的色度座標在 100% 與 75% 飽和下恢復一致，膚色 ΔE00 最大值回到門檻內。

## 新人避坑指南

看懂這條路徑的關鍵，是知道每一步在哪個域：

1. input CSC
2. de-gamma
3. gamut 轉換 + OOG 處理（只能在線性域）
4. gamma 再編碼
5. panel 補償
6. dithering

未來寫 code 或驗證時的檢查點：

1. **先問「在哪個域」**：任何 clamp、gain、矩陣運算，先確認輸入是線性域還是 gamma 編碼域。gamut 處理放錯域，症狀就是色相偏移，而且平均 ΔE 看不出來（只有高飽和格爆）。
2. **報告要看 max 與 95th percentile**：平均 ΔE00 全綠不代表過關，OOG 處理的問題永遠先出現在最大值。
3. **必測三類色**：膚色、高飽和紅、高飽和綠。這是 clip 死灰與 hue shift 的重災區，也是客訴第一現場。
4. **sRGB 模式要鎖使用者調整**：鎖色域的同時鎖 gamma／色溫調整範圍，否則使用者一調，校正全部作廢。鎖定規則寫進 FW spec，不要靠 OSD 預設值。
5. **模式切換用雙 bank＋vblank 單一 commit**：切換瞬間出現混合色域畫面，是模式切換類客訴的固定來源。
6. **產線把 sRGB 模式納入標準測項**：只測 Native／校正模式，等於客訴進來時手上沒有對照組。

## 思考題

同一個 sRGB 飽和紅，訊號 100% 和 75% 時，如果 sRGB→native 矩陣直接套在 gamma 編碼值上，兩者的色度會一樣嗎？請用 sRGB EOTF 算出編碼值 0.9 與 0.75 的線性值，並說明為什麼「先 de-gamma 再乘矩陣」才能讓色度不隨訊號大小改變。另外想一想：每個通道各自 clip 到 0 與 1，在編碼域做和在線性域做，結果會不會不同？

<details>
<summary>提示</summary>
sRGB EOTF：線性值 = ((c + 0.055) / 1.055)^2.4（c > 0.04045 時）。c = 0.9 時約 0.787，c = 0.75 時約 0.522（計算方式同 calc/gamut.py）。矩陣是線性運算，輸入是編碼值時，混色比例會隨訊號大小改變，色度就跟著漂。至於 clip：EOTF 把 0 對到 0、1 對到 1 且單調，所以兩個域 clip 的結果相同；hard clip 本身造成的色相偏移，在哪個域做都一樣。
</details>

## 參考資料

1. Rec. ITU-R BT.709-6（Parameter values for the HDTV standards for production and international programme exchange），官方：https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.709-6-201506-I!!PDF-E.pdf
2. Rec. ITU-R BT.2020-2（Parameter values for ultra-high definition television systems for production and international programme exchange），官方：https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2020-2-201510-I!!PDF-E.pdf （Table 3：primaries 與 D65 色度座標）
3. M. Stokes、M. Anderson、S. Chandrasekar、R. Motta，「A Standard Default Color Space for the Internet — sRGB」Version 1.10，1996-11-05，W3C 託管（IEC 61966-2-1 的前身提案，正式版 IEC 61966-2-1 需向 IEC 購買）：https://www.w3.org/Graphics/Color/sRGB （Table 0.2：BT.709 reference primaries 與 D65；simple clipping 對 OOG 的描述）
4. Report ITU-R BT.2408-8（11/2024，Suggested guidance for operational practices in high dynamic range television production），官方：https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-8-2024-PDF-E.pdf （HDR Reference White 203 cd/m²、58%PQ／75%HLG、Table 4 峰值對照表）

[^1]: M. Stokes、M. Anderson、S. Chandrasekar、R. Motta，〈A Standard Default Color Space for the Internet — sRGB〉Version 1.10，1996-11-05，W3C（見參考資料 3）。章節待查證。
