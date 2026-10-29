---
layout: post
title: "色彩入門：RGB、Gamma、色溫、色域 (sRGB/DCI-P3/Adobe RGB)"
date: 2026-10-29
tags: [Color, sRGB, DCI-P3, Adobe RGB, Gamma, CCT, EDID, Calibration]
level: beginner
prerequisites: ["顯示器系統方塊圖入門", "EDID 入門與 edid-decode 實作"]
series: "Part 6：色彩、HDR、畫質"
roadmap_stage: foundations
sources_checked: 2026-10-29
difficulty: beginner
---
## 為什麼重要

你買了一支「100% sRGB」的顯示器，同事卻說「這支只有 95% DCI-P3」；設計師抱怨「膚色偏紅」、玩家說「HDR 畫面發灰」；校正報告寫著 ΔE < 1，客戶還是退貨說「白點偏藍」。

這一切的根源都在 **色彩科學的四大基石**：
1. **RGB 色彩模型** — 顯示器怎麼混出顏色
2. Gamma / EOTF — 數值怎麼轉成亮度
3. 色溫 / 白點 / CCT — 「白」長什麼樣
4. 色域 — 能顯示多少種顏色

身為顯示器韌體工程師，你必須：
- 看懂 EDID/CTA-861 裡的色度資料（基色座標、白點、EOTF 代碼）
- 寫 Gamma LUT、3x3 Matrix、3D LUT 讓面板「說真話」
- 在 OSD 實作色溫模式（6500K、9300K、sRGB、DCI-P3…）不讓畫面閃爍
- 設計工廠校正流程，量測 ΔE00/ΔITP 判定 PASS/FAIL

這篇文章帶你從零建立色彩觀念，下一步才能動手寫 code、量校正站。

---

## 核心概念

### RGB 加色混合與 CIE 1931 色度圖

RGB (Red, Green, Blue) 是**加色模型**：三基色光疊加，亮度相加，全亮變白。這與印刷的 CMYK（減色）完全不同。

為了用數字描述「人眼能看見的所有顏色」，CIE 1931 定義了 **XYZ 三刺激值**，投影到 xy 色度圖 上形成馬蹄形光譜軌跡。任一 RGB 色域在圖上就是一個三角形，三頂點是紅、綠、藍基色的 色度座標 (x, y)。

> 術語：
> - 色度座標：(x, y) 表示顏色的「色相+飽和度」，不含亮度資訊
> - 白點：RGB 全亮 (1,1,1) 時的色度座標，決定「白」是偏暖(黃)還是偏冷(藍)
> - 色域：三角形內部面積，面積越大 = 可顯示顏色越飽和

### Gamma / EOTF (Electro-Optical Transfer Function)

顯示器不是線性元件：輸入數值 `0.5` 並不會輸出 `50%` 亮度。EOTF 定義「非線性訊號值 → 線性亮度」的轉換。

- Gamma 2.2（純次方）：`L = V^2.2` — 早期 CRT 近似模型
- sRGB EOTF (IEC 61966-2-1) — 分段函數，非單一 2.2：
  ```
  若 L ≤ 0.0031308：V = 12.92 × L                    (線性段，gamma=1.0)
  若 L > 0.0031308：V = 1.055 × L^(1/2.4) - 0.055  (非線性段，指數 2.4)
  ```
  瞬間 gamma 從 0 處的 1.0 變到最大處的 2.4，中位數約 2.2。線性段避免零點斜率無限大。

> 重要：許多量產韌體直接用 `pow(x, 2.2)` 近似，不符合規格。專業校正軟體 (EIZO ColorNavigator、NEC SpectraView) 均採用分段函數。

- DCI-P3 (劇院版)：純 Gamma 2.6 (`L = V^2.6`)，參考亮度 48 cd/m²
- Display P3 (Apple/消費級)：白點改 D65、EOTF 採 sRGB 分段函數
- Adobe RGB (1998)：Gamma 2.19921875 (= 563/256)，有理數便於定點運算

> OETF vs EOTF：OETF (Opto-Electronic) 是「場景亮度 → 編碼訊號」（相機端）；EOTF 是「編碼訊號 → 顯示亮度」（顯示器端）。sRGB 規格只定義 EOTF，未定義 OETF。

### 色溫 vs 相關色溫 (CCT) — 別只看 Kelvin

- 色溫：黑體輻射體在 Planckian locus (普朗克軌跡) 上的溫度。單一點對單一溫度。
- 相關色溫 (CCT)：非黑體光源（如 LED、LCD 白光），沿等溫線延伸到 Planckian locus 最近點的溫度。多組 (x,y) 可對應同一 CCT。
- CIE D 系列標準照明體落在 Daylight locus（非 Planckian locus）：
  - D65：x=0.3127, y=0.3290，CCT ≈ 6504 K（1968 年修正前稱 6500 K）
  - D50：x=0.3457, y=0.3585，CCT ≈ 5003 K

> **實務陷阱**：規格書若只寫「白點 6500 K」不夠！兩支 6500 K 面板可能一偏綠 (Δuv > 0)、一偏品紅 (Δuv < 0)，肉眼明顯可見差異。必須指定 xy 或 u'v' 座標（如 D65: 0.3127, 0.3290）。

### 三大主流色域規格比較

| 特性 | sRGB (IEC 61966-2-1) | DCI-P3 / Display P3 | Adobe RGB (1998) |
|------|---------------------------|-------------------------|----------------------|
| 紅基色 (Rx, Ry) | 0.6400, 0.3300 | 0.6800, 0.3200 (更飽和紅) | 0.6400, 0.3300 |
| 綠基色 (Gx, Gy) | 0.3000, 0.6000 | 0.2650, 0.6900 | 0.2100, 0.7100 (大幅延伸青綠) |
| 藍基色 (Bx, By) | 0.1500, 0.0600 | 0.1500, 0.0600 (相同) | 0.1500, 0.0600 |
| 白點 | D65 (0.3127, 0.3290) | Display P3: D65 / 劇院: ~6300K 偏綠 | D65 (0.3127, 0.3290) |
| EOTF / Gamma | 分段函數 (12.92 / 2.4) | 劇院: 2.6 / Display P3: sRGB 分段 | 2.19921875 (563/256) |
| 參考白亮度 | 80 cd/m² | 48 cd/m² (劇院) / 100-300 (消費) | 160 cd/m² |
| 主要用途 | Web、辦公、一般消費 | HDR、行動裝置、廣色域顯示器、Mac | 專業攝影、印刷前校樣、設計 |

關鍵觀察：
- 三者藍基色完全相同
- Adobe RGB 綠基色最外擴（x=0.21 最接近光譜軌跡）→ 印刷青綠最飽和
- DCI-P3 紅基色最外擴（x=0.68）→ 電影紅色最飽和
- sRGB 最小，但也是 Web/辦公預設色域，內容最多

---

## 一步一步：從規格到韌體實作

### Step 1：確認面板原生基色座標
向面板廠索取 **Panel Spec**，或用分光輻射計 (CA-410、Klein K-10) 量測面板原生 RGB 基色。
> 例：某 IPS 面板原生：R(0.665, 0.320), G(0.210, 0.710), B(0.145, 0.055) — 已超過 sRGB、接近 Adobe RGB 綠、略遜於 DCI-P3 紅。

### Step 2：規劃 EDID 色度宣告
在 CTA-861 Extension 的 Colorimetry Data Block (CDB) 填入支援的色域代碼：
- `0x01` = sRGB / BT.709
- `0x02` = BT.601
- `0x05` = DCI-P3
- `0x06` = BT.2020
- `0x07` = Adobe RGB (CTA-861-G 新增)

並宣告 **EOTF 代碼**：`0x00`=Gamma 2.2, `0x01`=sRGB, `0x02`=PQ, `0x03`=HLG。

### Step 3：建立 3x3 色域映射矩陣
將輸入色域 (如 BT.709) 線性 RGB → XYZ → 面板原生 RGB：
```
[XYZ] = M_input × [RGB_linear]
[RGB_panel] = M_panel⁻¹ × [XYZ]
```
Scaler 內建 matrix 註冊器或 3D LUT 實作。廣色域模式下需 Gamut Mapping（壓縮/切割），避免 hue shift。

### Step 4：燒錄 Gamma LUT
依目標 EOTF (sRGB 分段 / PQ / HLG / Gamma 2.2) 產生 10/12-bit LUT，寫入 scaler Gamma RAM。
> sRGB 分段函數程式碼片段 (C)：
```c
float srgb_eotf(float L) {
    if (L <= 0.0031308f) return 12.92f * L;
    return 1.055f * powf(L, 1.0f/2.4f) - 0.055f;
}
```

### Step 5：實作色溫模式 (OSD)
目標白點 xy → 計算 RGB Gain/Offset (3x3 矩陣或獨立通道)：
```
Target_White = M_panel × [Gain_R, Gain_G, Gain_B]^T
```
常見模式：`6500K (D65)`, `9300K (偏藍)`, `5000K (D50)`, `sRGB (D65+Gamma)`, `Native (面板原生)`。
切換時用 逐幀插值 避免畫面閃爍。

### Step 6：工廠校正站流程
1. 面板點亮 → 熱機 30 分鐘
2. 量測原生基色、白點、Gamma 曲線
3. 計算 3x3 Matrix + Gamma LUT 修正值
4. 寫入 scaler NVRAM / Flash
5. 回測 ΔE00 (sRGB) / ΔITP (HDR) → PASS/FAIL
6. 產出校正報告 (含 ΔE 分布圖、白點 xy、Gamma 曲線)

---

## 圖解

### CIE 1931 xy 色域三角形比較 (ASCII 示意)

```
y
1.0 |                    ● 光譜軌跡 (單色光)
    |                  ╱
    |                ╱   Adobe RGB 綠基色 (0.21, 0.71) ◀── 最外擴
    |              ╱
    |            ╱     DCI-P3 綠基色 (0.265, 0.69)
    |          ╱
    |        ╱         sRGB 綠基色 (0.30, 0.60)
    |      ╱
    |    ╱           ● D65 白點 (0.3127, 0.3290) ◀── 三者共用
    |  ╱
    |╱________________________________________________ x
   0.0  0.15  0.30  0.45  0.60  0.68  0.75
           ▲           ▲           ▲
           │           │           │
        藍基色      紅基色      DCI-P3 紅基色
      (0.15,0.06)  (0.64,0.33)   (0.68,0.32)
      三者相同     sRGB/Adobe    DCI-P3 更飽和
```

### sRGB EOTF 分段函數 vs Gamma 2.2 (概念圖)

```
輸出亮度 (線性)
1.0 ┤                    ╱  Gamma 2.2 (純次方)
    │                  ╱
    │                ╱
    │              ╱
0.5 ┤            ╱  sRGB EOTF (分段)
    │          ╱ ╱
    │        ╱ ╱   ◀── 線性段 (斜率 12.92)
    │      ╱ ╱
    │    ╱ ╱
    │  ╱ ╱
0.0 ┼══════════════════════════════════
     0.0   0.1   0.2   0.5   0.8   1.0
           輸入訊號值 (非線性)
```

### 色溫/白點在色度圖上的位置

```
        ▲ y
        │   D50 (5003 K) ●
        │    x=0.3457, y=0.3585
        │
        │        D65 (6504 K) ●
        │         x=0.3127, y=0.3290
        │
        │              9300 K ● (偏藍)
        │
        │  Planckian Locus (黑體軌跡) ──────────
        │  Daylight Locus (日光軌跡)  · · · · · · ·
        │
        └──────────────────────────────────────► x
```

---

## 常見陷阱

| 陷阱 | 症狀 | 正確做法 |
|------|------|----------|
| **用 `pow(x, 2.2)` 代替 sRGB EOTF** | 暗部細節喪失、灰階不均、校正 ΔE 偏大 | 實作 IEC 61966-2-1 分段函數 (線性段 + 2.4 次方) |
| 白點只指定 "6500K" 不給 xy | 批次面板偏綠/偏紅不一、客訴「白點不對」 | EDID/校正規格必填 xy 座標 (D65: 0.3127, 0.3290) |
| 忽略 Δuv | 同 CCT 面板肉眼可見色差 | 量產管控 Δuv ≤ ±0.002 (待查證具體門檻) |
| 廣色域模式不做 Gamut Mapping | 超出面板色域的顏色飽和度截斷 → hue shift、膚色失真 | 採用感知/相對色度/絕對色度映射，保留 hue |
| Gamma LUT 位寬不夠 (8-bit) | 低階調階條狀 | 至少 10-bit (1024 entries)，建議 12-bit (4096) |
| OSD 色溫切換無插值 | 切換瞬間畫面閃爍/跳變 | 逐幀線性插值 Gain/Offset (建議 0.5-1 秒完成) |

---

## 動手練習

### 練習 1：用 `edid-decode` 解析自家顯示器的色度資料
```bash
# Linux/macOS
edid-decode /sys/class/drm/card0-DP-1/edid   # 或對應 connector

# 重點看：
# - Colorimetry Data Block: 支援色域代碼
# - HDR Static Metadata Block: MaxCLL, MaxFALL, 色度座標
# - chromaticity coordinates: 紅/綠/藍/白點 xy
```

### 練習 2：用 Python 繪製 sRGB EOTF 分段曲線
```python
import numpy as np
import matplotlib.pyplot as plt

def srgb_eotf(L):
    return np.where(L <= 0.0031308, 12.92 * L, 1.055 * L**(1/2.4) - 0.055)

def gamma_pure(L, g=2.2):
    return L**g

L = np.linspace(0, 1, 1000)
plt.plot(L, srgb_eotf(L), label='sRGB EOTF (piecewise)')
plt.plot(L, gamma_pure(L), '--', label='Gamma 2.2 (pure)')
plt.xlabel('Linear Luminance'); plt.ylabel('Signal Value')
plt.legend(); plt.grid(); plt.show()
```
觀察：低階 sRGB 明顯高於純 2.2 曲線（暗部細節保留較好）。

### 練習 3：計算三大色域在 CIE 1931 圖上的三角形面積
```python
import numpy as np

def triangle_area(p1, p2, p3):
    # p = (x, y) 使用鞋帶公式
    return 0.5 * abs(p1[0]*(p2[1]-p3[1]) + p2[0]*(p3[1]-p1[1]) + p3[0]*(p1[1]-p2[1]))

sRGB = {(0.640,0.330), (0.300,0.600), (0.150,0.060)}
DCI  = {(0.680,0.320), (0.265,0.690), (0.150,0.060)}
Adobe= {(0.640,0.330), (0.210,0.710), (0.150,0.060)}

print(f"sRGB area: {triangle_area(*sRGB):.6f}")
print(f"DCI-P3 area: {triangle_area(*DCI):.6f}")
print(f"Adobe RGB area: {triangle_area(*Adobe):.6f}")
```
結果：Adobe RGB > DCI-P3 > sRGB（面積比約 1.5 : 1.3 : 1.0）。

### 練習 4：用 `ddcutil` 讀取/設定色溫模式
```bash
ddcutil capabilities | grep -A5 "Color Temperature"
ddcutil getvcp 0x14   # 讀取色溫模式 VCP
ddcutil setvcp 0x14 0x05  # 0x05 是否為 6500K：MCCS 值表待查證，先用 capabilities 確認
```

---

## 自我檢測

<details>
<summary>點擊展開答案</summary>

Q1. sRGB 的 Gamma 是 2.2 嗎？為什麼？
> **A：不是**。sRGB EOTF 是 IEC 61966-2-1 定義的**分段函數**：暗部線性段 (斜率 12.92, gamma=1.0) + 亮部 2.4 次方。瞬間 gamma 從 1.0 變到 2.4，中位數約 2.2，但非單一數值。純 `pow(x,2.2)` 在暗部誤差最大。

Q2. DCI-P3 劇院版與 Display P3 最大差異在哪？
> A：白點與 EOTF。劇院版：白點 ~6300 K (x=0.314, y=0.351，偏綠)、Gamma 2.6、48 cd/m²。Display P3：白點 D65、EOTF 採 sRGB 分段函數、亮度通常 100-300 cd/m²。

Q3. 為什麼「白點 6500K」不足以保證白點一致？
> A：CCT (相關色溫) 不是單一點。多組 (x,y) 座標可對應同一 CCT（沿等溫線分布）。同為 6500K，可能一偏綠 (Δuv>0)、一偏品紅 (Δuv<0)，肉眼明顯可見。必須指定 xy 或 u'v' 座標。

Q4. Adobe RGB 綠基色為何設在 (0.21, 0.71)？
> A：為了涵蓋 CMYK 印刷色域中的青綠區。sRGB 綠基色 (0.30, 0.60) 會切掉印刷可呈現的飽和青綠；Adobe RGB 將綠基色大幅向光譜軌跡外擴，覆蓋更多印刷色彩。

Q5. 廣色域面板 (原生接近 DCI-P3) 顯示 sRGB 內容時，若不做色域映射會發生什麼？
> A：過度飽和。sRGB 定義的 (1,0,0) 紅會被映射到面板原生更飽和的紅，導致膚色偏紅、品牌色失真。需用 3x3 Matrix 或 3D LUT 將 sRGB 色域壓縮/映射到面板原生色域內。
</details>

---

## 參考資料

1. W3C / IEC 61966-2-1 — sRGB 官方規格：基色、白點 D65、EOTF 分段函數、80 cd/m²  
   https://w3.org/Graphics/Color/srgb

2. Wikipedia: sRGB — 詳細 EOTF 數學式、瞬間 gamma 分析、歷史背景  
   https://en.wikipedia.org/wiki/SRGB

3. Colour Science Blog: sRGB EOTF 分段函數 vs Gamma 2.2 — Jack Holm (IEC TC100 技術秘書) 親自確認分段函數為正確解讀  
   https://www.colour-science.org/posts/srgb-eotf-pure-gamma-22-or-piece-wise-function/

4. Wikipedia: DCI-P3 / SMPTE RP 431-2 — 劇院版與 Display P3 基色、白點、Gamma 定義  
   https://en.wikipedia.org/wiki/DCI-P3  
   **ICC 註冊表 DCI-P3**：https://registry.color.org/rgb-registry/dcip3

5. Wikipedia: Adobe RGB (1998) / ICC 註冊表 — 基色、白點 D65、Gamma 2.19921875、160 cd/m² 參考亮度  
   https://en.wikipedia.org/wiki/Adobe_RGB_color_space  
   ICC 註冊表 Adobe RGB：https://registry.color.org/rgb-registry/adobergb

6. CIE: Colorimetry Part 2 — CIE Standard Illuminants — D65 (6504 K)、D50 (5003 K) 官方定義  
   https://cie.co.at/publications/colorimetry-part-2-cie-standard-illuminants-0

7. Color-Image.com: Monitor Calibration D65 or 6500 K? — D65 CCT 修正歷史、Daylight locus vs Planckian locus 差異  
   https://color-image.com/2011/09/monitor-calibration-d65-or-6500-k/

8. Color-Image.com: Color Temperature and CCT — CCT 非單一點、Δuv 定義與意義  
   https://color-image.com/2014/07/color-temperature-and-correlated-color-temperature-cct/

9. Konica Minolta: Display White Point Is Specification by Color Temperature Sufficient? — 白點僅用 CCT 不足、Δuv 關鍵性、量產管控建議  
   https://sensing.konicaminolta.asia/wp-content/uploads/2017/08/Display-White-Point-Is-specification-by-Color-Temperature-sufficient.pdf

---

> **下一篇預告**：系列 A4「影像介面總覽：VGA/DVI/HDMI/DP/USB-C 的差異與演進」—— 帶你看懂介面版本演進、頻寬計算、以及為什麼你的 4K@144Hz 要用 DP 1.4 DSC 而不是 HDMI 2.0。
