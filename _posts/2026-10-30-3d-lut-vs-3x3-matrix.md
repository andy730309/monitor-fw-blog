---
layout: post
title: "3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因"
date: 2026-10-30
tags: [3D-LUT, color-matrix, calibration, scaler, DisplayHDR, sRGB]
level: intermediate
prerequisites: ["色彩入門：RGB/gamma/色溫/色域", "工廠色彩校正流程與 takt time"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-10-30
difficulty: intermediate
---
# BLOG 標題：3D LUT 還是 3x3 矩陣？廣色域螢幕 sRGB 模式中間色爆掉的真正原因

## 【前置知識準備】

把顯示器的色彩校正想成「調音」。3×3 matrix 就像調音台上的三支主推桿——R、G、B 各一支，你把三支推到定位，整體音色就大致對了。問題是：三支推桿只能做「線性」的調整。如果某個頻段（例如中頻人聲）自己偏掉了，三支推桿救不了，因為它們對所有頻段一視同仁地等比縮放。

3D LUT（three-dimensional look-up table，三維查找表）則像是一張密密麻麻的對照表：在 RGB 立方體裡每隔一段距離插一支旗桿（17×17×17、33×33×33 甚至 65×65×65 個節點），每個節點寫著「這個輸入顏色應該輸出成什麼」。落在兩支旗桿中間的顏色，靠插值（interpolation）算出來。這樣一來，立方體內部每個角落都能個別修正，包括 LCD 特有的非線性通道竄漏（crosstalk）與 S 型曲線。

ICC 規格把 display profile 分成兩大類正好呼應這件事：Matrix/TRC 型（3×3 colorant matrix + 每通道一條 tone curve）與 LUT 型（matrix + 1D + 3D CLUT + 1D）。前者簡單、省記憶體、只修得好「線性」的部分；後者精準、吃記憶體，還牽涉插值演算法選得好不好。

## 【系統廠真實血淚案例】

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 27 吋 4K 高更新率廣色域機種，DVT 階段跑 DisplayHDR 預測試。白點 D65 修得很漂亮，RGB 三原色頂點 ΔE00 全過，偏偏 Color Accuracy 一關（ColorChecker 96 色，平均 ΔTP 門檻依 tier 為 6～8）壓線不過；客訴端還回報「膚色偏洋紅、天空藍怪怪的」。

FW 端 sRGB clamp 的實作很「省」：量測 RGB primaries → 解一組 3×3 gamut matrix → 寫進 scaler color matrix stage。而且 gamma-coded 的 RGB 資料直接進矩陣，沒有先 de-gamma。

```c
/* 示意路徑（錯誤示範）：gamma-coded 直接進矩陣 */
Scaler_Register_Write32(REG_COLOR_PATH_CTRL,
                        COLOR_PATH_MATRIX_ONLY); /* 示意地址，非實際晶片規格 */
for (int k = 0; k < 9; k++) {
    Scaler_Register_Write32(REG_COLOR_MATRIX_BASE + k * 4,
                            q31_matrix[k]); /* 示意地址，非實際晶片規格 */
}
```

根因有三層：

1. 矩陣是線性變換，只能把三個原色頂點拉到目標；cube 內部的飽和度與色相誤差只能線性縮放。LCD cell 的非線性 crosstalk（R 在低亮度漏到 G 的量跟高亮度不一樣）矩陣天生修不了——這是 Poynton 與 Barsotti 論文裡講得很直白的事。
2. color matrix 的輸入必須是線性光。少了 input 1D LUT 做 de-gamma，矩陣等於在錯誤的座標系上做色域轉換，暗部與中間調整體偏移。
3. bit depth 預算不足。Portrait Displays 的公開白皮書給的經驗值：LUT 精度至少比視訊輸入高 2 bit，pipeline 運算至少再高 2 bit。10-bit 輸入配 10-bit LUT，插值後的連續性被量化切碎，表現就是 ramp banding。

修正後的骨架：

```c
/* de-gamma → 3D LUT → 輸出 gamma；示意地址，非實際晶片規格 */
load_1d_degamma(FLASH_DEGAMMA_DEFAULT);
if (load_lut_from_flash(FLASH_LUT_SRGB) != 0) {
    /* CRC 錯就退回 matrix-only，別讓壞資料打爛畫面才送去客訴 */
    Scaler_Register_Write32(REG_COLOR_PATH_CTRL, COLOR_PATH_MATRIX_ONLY);
} else {
    Scaler_Register_Write32(REG_COLOR_LUT_CTRL, COLOR_PATH_LUT3D);
}
```

切換 LUT bank 要在 vblank 期間做，HDR10 路徑（PQ + ST 2086 static metadata）與 SDR sRGB 路徑的校正目標不同，分開存兩套 bank，不要硬塞同一張表。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

不是單一暫存器，是「pipeline 順序」：input 1D LUT（de-gamma）→ 3D LUT → color matrix（若保留粗調）→ output 1D LUT（gamma）。在 scaler 端通常對應一組 color path control 的 mux，決定資料流經哪些 stage。真正該盯的是：你的 3D LUT 是吃 gamma-coded 還是 linear light？它在 brightness/contrast 前面還是後面？（這兩個 control 一動，整個 LUT 的輸入座標就平移，先前校正全廢。）

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- 先畫 bit depth 預算表再寫 code。輸入位元數 → LUT 精度（≥ 輸入+2）→ pipeline（≥ LUT+2）→ panel 驅動，一格都不能省。
- 校正順序反著來：white balance（最靠近 panel）→ multipoint grayscale → matrix 粗調 → 3D LUT 收非線性。3D LUT 永遠最後校。
- LUT blob 上 flash 必須帶 CRC 與 panel serial 綁定，boot 驗證失敗退回 matrix-only 並留錯誤碼。
- 驗證不要只量 color patch。0～1023 單步灰階與 R/G/B 單步掃描比 ColorChecker 更早抓到 banding 與插值跳點。
- 模式切換（SDR/HDR、sRGB/Native）時確認 LUT bank 有分開存，切換在 vblank 執行。

### 3. 思考題

DisplayHDR CTS 1.2 對 Luminance and White Point Accuracy 用 ΔITP 容差（50 cd/m² 以上為 10），對 Color Accuracy 另用 ColorChecker 的平均 ΔTP（依 tier 為 6 或 8）。如果一台機種 ΔITP 全過、ΔTP 壞在中飽和色，你會先懷疑 pipeline 的哪一段、又要怎麼用單步 ramp 把它跟「插值 ringing」區分開來？

<details>
<summary>提示（想完再看）</summary>

ΔITP 主要反映亮度與白點軌跡，ΔTP 的 96 色包含大量非頂點、非灰階的中間色。先檢查 3D LUT 節點間的插值模式與 ramp 是否單調——若是量化或插值問題，單步 ramp 會出現階梯或非單調跳點；若是矩陣本身不夠，ramp 平滑但中飽和 patch 的色相持續偏移。

</details>

## 參考資料

- Portrait Displays（官方廠商文件）: https://www.portrait.com/resource-center/3d-lut-calibration-best-practices-for-manufacturers/
- International Color Consortium FAQ（display profile 結構）: https://www.color.org/faqs/
- ICC.1:2022-05 規格: https://www.color.org/specification/ICC.1-2022-05.pdf
- VESA DisplayHDR Performance Criteria（CTS 1.2 摘要）: https://displayhdr.org/performance-criteria/
- C. Poynton, J. Barsotti, "Innovations in 3-D colour LUTs for display calibration": https://doi.org/10.1049/ib.2014.0036
- NVIDIA GTC 2010 海報（tetrahedral interpolation）: https://www.nvidia.com/content/GTC/posters/2010/V01-Real-Time-Color-Space-Conversion-for-High-Resolution-Video.pdf
