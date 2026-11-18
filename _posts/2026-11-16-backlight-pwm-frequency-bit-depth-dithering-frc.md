---
layout: post
title: "背光 PWM 頻率與 bit depth：low-bit dithering/FRC 畫質的取捨"
date: 2026-11-16
tags: [PWM, backlight, dithering, FRC, flicker, DisplayHDR]
level: intermediate
prerequisites: ["色彩入門：RGB、gamma、色溫、色域", "3D LUT 與 3x3 matrix 在 scaler 中的實作差異"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-16
description: "背光 PWM 頻率、duty 與 bit depth 受同一時脈限制，要高頻就得犧牲 bit depth。本文說明與 dithering／FRC 的取捨。"
difficulty: intermediate
---
> **重點摘要**：PWM 頻率決定 flicker 是否可見，duty 決定亮度，bit depth 決定亮度階梯的細緻程度，三者受同一時脈限制。頻率越高，最小 on-time 對應的最低 duty 越大，低亮度解析度越差。dithering 與 FRC 用時間換解析度，但可能引入低頻拍頻。

## 前置知識

PWM（Pulse Width Modulation）調光的本質是快速開關背光 LED，用 duty cycle 控制平均亮度。頻率（Hz）決定 flicker 是否可見，duty cycle 決定亮度，bit depth 決定亮度階梯的細緻程度。三者受同一時脈限制：要更高頻率就得犧牲 bit depth。FRC（Frame Rate Control）與 PWM dithering 則是用時間換解析度，以幀間或段間切換模擬中間灰階；切換圖樣的重複週期如果落在低頻，就會變成看得到的包絡。TÜV Flicker Free（certipedia keyword 1830）的說明是：在多種亮度設定下，0–3000 Hz 範圍內沒有該標準定義的可見與不可見 flicker。

## 技術核心

### PWM 頻率與 bit depth 的物理耦合

LED driver 的 PWM 解析度與載波頻率受同一振盪器限制。以 ams-OSRAM AS1163 公開文件為例：15-bit 解析度對應 500 Hz、14-bit 對應 1 kHz（標稱值；19.2 MHz 振盪器下實際約 586 Hz 與 1172 Hz，AS1163 PWM settings PDF p.5），原生 16-bit 會讓 PWM 頻率太低，所以改用 LSB dithering 補第 16 bit（同文件 p.7）。另一個例子：16-bit 加 2 kHz，時脈要 65,536 × 2000 = 131.072 MHz（Powersystemsdesign 公開文獻）。因此在時脈固定、不做 dithering 的前提下，「提高頻率」就要犧牲 bit depth，低亮度量化階梯變粗。

### Duty cycle 下限與最小可調亮度

PWM 低亮度的最小 on-time 受 LED 上升/下降時間限制。公開的數學推算範例（TFT Display Technology，作者註明是假設值，不是建議工作點）：假設最小有用 on-time 1 µs，則 1 kHz → 最小 duty 約 0.1%（1000:1）、5 kHz → 0.5%（200:1）、20 kHz → 2%（50:1）、40 kHz → 4%（25:1）。頻率越高，低亮度解析度越差，甚至無法達到目標最低亮度。

### Dithering / FRC 引入低頻 beat

Lumissil IS31FL3248 公開資料：dithered mode 將解析度拆為 B = H + L，每個 PWM frame 切成 2^L 個短段、每段跑 H-bit PWM，把 L bits 的餘數分散到各段，平均仍得 B-bit。主要的切換頻率因此提高 2^L 倍，這是它減少閃爍的原因。但是當只有少數幾段帶脈波時（低亮度常見），看得到的週期會退回整個 PWM frame，也就是比每段 PWM 慢 2^L 倍的低頻成分（Lumissil PWM Dithering 技術文章）。這個低頻成分如果和面板更新率或 CA-410 積分時間不同步，就會出現亮度波動與 beat 條紋。TCON 端 FRC 以 N/(N+1) 幀切換相鄰 code，需與 polarity inversion 對齊，否則殘留 DC 與 flicker beat（Vectree 公開說明）。

### 量測系統陷阱

CA-410 有 Double-Frame、Single-Frame 等積分時間設定，並支援同步量測（Konica Minolta CA-410 catalog p.2）；低灰階實際積分時間多長，型錄文字版沒有列出（待查證，請查使用手冊）。PWM dithering 的低頻成分若沒有被整數個週期涵蓋，量測值會隨相位漂移，幅度要實測。PWM 頻率要用示波器 + 光感測器量測；相機移動拍攝法可以看出至少約 500 Hz 的 PWM，更高頻可能看起來像沒有 PWM（TFTCentral）。

### 韌體修正方向

依目標最低亮度與 TÜV 0–3000 Hz 範圍選 (freq, bits) 組合；低亮度改 DC dimming 或 hybrid；FRC 與 PWM dithering 盡量不同時啟用（設計選擇）；量測積分時間要涵蓋整數個 dithering 低頻週期，或使用同步量測；DisplayHDR 認證測試時，關閉會隨畫面變動的動態調光功能，改用固定設定。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 27 吋 W-LED monitor DVT 送 DisplayHDR 400 預測試，回報：（1）亮度 <30% 時 10-bit ramp 出現 banding，暗部 0–32 code 跳階；（2）240 fps 慢動作拍攝見水平暗條紋捲動；（3）SDR 15% 亮度量測波動 ±4%。FW 團隊先「拉高到 20 kHz」，結果暗部 crushing 更嚴重、LED driver 溫度上升。根因是 PWM 頻率 × bit depth × dithering/FRC 耦合，非單一參數。

## 新人避坑指南

- 不要把「提高 PWM 頻率」當萬靈丹；先算最小 duty 是否仍能達到目標最低亮度。
- 量測 PWM 頻率用示波器 + 光感測器；相機法約 500 Hz 以上就不可靠。
- 低亮度改 DC dimming 或 hybrid，避免 dithering 包絡與更新率 beat。
- FRC 與 PWM dithering 盡量不同時啟用；TCON FRC 圖樣要對齊 polarity inversion。
- CA-410 量測低灰階時，積分時間涵蓋整數個 dithering 週期或用同步量測，多次取中位數。
- DisplayHDR 認證測試時，動態調光功能改成固定設定。

## 思考題

若目標最低亮度為 5 cd/m²、峰值 400 cd/m²，最小有用 on-time 1 µs，哪個 (freq, bits) 組合能同時滿足 TÜV 0–3000 Hz 門檻與最低亮度？若無可行組合，FW 應如何處理？

<details><summary>提示</summary>
計算目標最低 duty = 5/400 = 1.25%（假設亮度與 duty 成正比）；最小 duty = 1 µs × freq，所以 freq ≤ 12.5 kHz。TÜV 範圍到 3000 Hz，PWM 基頻要高於 3 kHz。因此 3 kHz 到 12.5 kHz 之間可行，例如 5 kHz（最小 duty 0.5%）。bits 由時脈決定：16.384 MHz 時脈下 5 kHz 約有 3276 個計數（約 11.7 bit）。若 dithering 低頻成分落進 0–3000 Hz，仍可能不過，實際以 TÜV 測試目錄為準（待查證）。若無可行組合，改 DC dimming 或 hybrid。
</details>

## 參考資料

- TÜV Rheinland Flicker Free keyword 1830（官方）：https://www.certipedia.com/keywords/1830
- TFTCentral PWM article (2015)（非官方）：https://tftcentral.co.uk/articles/pulse_width_modulation
- TFT Display Technology, "Choosing PWM Frequency for LCD Backlight Dimming"（非官方）：https://tft-display.net/posts/lcd-backlight-pwm-frequency/
- Lumissil, "PWM Dithering for High-Color Resolution & Flicker-Free LED Light" (IS31FL3248)（官方）：https://www.lumissil.com/upload/assets/pdf/Technical_Articles/Lumissil-PWM-Dithering.pdf
- ams-OSRAM AS1163 PWM settings PDF（官方；500 Hz／15-bit、1 kHz／14-bit 在 p.5，LSB dithering 在 p.7）：https://look.ams-osram.com/m/30b3ff9b4cc83ae/original/AS1163-PWM-settings-multiple-driving-options.pdf
- Powersystemsdesign, "Better LED Intensity Control in Video Displays"（非官方）：https://www.powersystemsdesign.com/articles/better-led-intensity-control-in-video-displays/36/5688
- Vectree, TCON role (FRC dithering / local dimming)（非官方）：https://vectree.io/c/role-of-the-display-timing-controller-tcon-overdrive-panel-gamma-luts-frc-dithering-local-dimming-and-rowcolumn-driver-scanning
- Konica Minolta CA-410 catalog（官方）：https://www.konicaminolta.com/instruments/download/catalog/display/pdf/ca410_catalog_eng.pdf
- LEDStrain Wiki, PWM/temporal dithering/FRC（非官方）：https://wiki.ledstrain.org/docs/known-problems/problems_monitors_laptops/
- Newhaven Display, "Backlight Driving with PWM"（官方）：https://support.newhavendisplay.com/hc/en-us/articles/4415342182551-Backlight-Driving-with-PWM
