---
layout: post
title: "Mini-LED 背光 PWM 頻率與 FRC 拍頻實戰：如何消除低灰階條帶化與閃爍"
date: 2026-11-14
tags: [Mini-LED, Backlight, PWM, FRC, Dithering, Color]
level: intermediate
prerequisites: ["從零成為顯示器架構師：背光控制基礎與 FRC 原理"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-14
difficulty: intermediate
---
## 前置知識

在顯示器架構中，背光調光（Backlight Dimming）與面板畫素色彩處理（如 Bit Depth、FRC / Dithering）是決定暗場畫質與色彩平滑度的兩個關鍵子系統。

初學者常誤以為背光調光（PWM 或 DC）與 Scaler 端的 FRC（Frame Rate Control，時序抖動）是互不干擾的：
- 背光 PWM（Pulse Width Modulation）：透過高速切換 LED 電流的佔空比（Duty Cycle）來控制巨觀亮度。頻率太低，人眼或相機會看到閃爍；頻率太高，LED driver 的切換損耗變大，而且最小 on-time 會限制最低 duty。
- FRC / Dithering：當面板為原生 8-bit（256 階）時，為了呈現 10-bit（1024 階）的色彩細節，透過空間雜訊（Spatial Dithering，如 Bayer matrix）與時間雜訊（Temporal FRC，多幀輪換 LSB）在視覺上混合出中間色階。

當 Mini-LED 局部控光（Local Dimming）與高更新率（如 144 Hz 以上）結合時，若 PWM 頻率和畫面更新率沒有整數倍關係、相位也沒對齊，兩者的亮度調變會互相混疊，產生差頻（Beat Frequency）。在低灰階（0–16 灰階）區域，這會表現成移動的橫向亮暗帶與閃爍。

## 技術核心

要解決低灰階條帶化與 FRC 差頻問題，韌體要從三個方向下手：PWM 頻率規劃、混合 Dithering 演算法、背光動態增益補償。

### 1. PWM 頻率與更新率的整數倍設計（避免差頻）
若面板更新率為 144 Hz，背光 PWM 設為 480 Hz，480／144 ≈ 3.33，不是整數倍。每一幀開始時 PWM 的相位都不同，相位圖樣每 1／48 秒重複一次；以 144 Hz 看 480 Hz，混疊出來的頻率是 |480 − 3 × 144| = 48 Hz（計算見 calc/beat.txt）。48 Hz 落在 IEEE 1789 認為容易看見閃爍的低頻區（90 Hz 以下）。
- 解法：把 PWM 頻率設成更新率的整數倍（例如 144 Hz × 25 = 3.6 kHz），並在每個 VSYNC 重新起算 PWM 週期。VRR（Variable Refresh Rate）下每一幀長度都不同，光靠「量更新率、改 PWM 頻率」追不上，要靠 VSYNC 同步重啟。
- 頻率參考：IEEE Std 1789-2015 的建議是，1250 Hz 以上低風險、不限調變深度；3000 Hz 以上連「無可觀察效應」區也不限調變深度（來源：DOE SSL Postings 2015-06-11 摘要，https://www.energy.gov/sites/prod/files/2015/06/f22/postings_06-11-15.pdf ；IEEE 原文條文頁碼待查證）。3.6 kHz 落在 3000 Hz 以上。
- 相位對齊：每幀都從 VSYNC 後固定延遲（例如 100 µs，示意值）開始第一個 PWM 脈波，讓每一幀的亮度圖樣相同。注意 3.6 kHz 時每幀有 25 個脈波，PWM 一定會在液晶掃描期間開關；相位對齊的目的是讓每幀一致，不是避開掃描。

### 2. Spatial-Temporal 混合 Dithering 與背光增益補償
Scaler 端若僅做單純的 temporal FRC，在低灰階（code 0–16）時每一階的亮度差很小，FRC 的閃爍和 PWM 的調變疊在一起更容易被看見。
- 解法：結合 Spatial（如 4×4、8×8 或 16×16 Bayer matrix，或 blue noise）與 Temporal 混合 dithering。Bayer matrix 的邊長是 2 的次方（Wikipedia「Ordered dithering」，https://en.wikipedia.org/wiki/Ordered_dithering ）。再加上背光增益補償 LUT（BL_GAIN_LUT）：當 Local Dimming zone duty 偏低（例如 < 15%，示意門檻）時，依 LUT 補償畫素值，抵消背光在低 duty 的非線性。實際改善幅度（ΔE00）要用量測驗證，本文不提供數值（待查證）。

### 3. DC/PWM 混合調光模式（兼顧極低亮度）
當亮度很低時，若硬把 PWM duty 壓到極低（例如 < 5%），脈波寬度會接近 LED driver 的最小 on-time，電流還沒爬到設定值就關掉，亮度不線性、不同 zone 之間不一致。
- 解法：實作 DC/PWM 混合切換。常見有兩種方向：一是高亮度用 DC（調電流）、低亮度改 PWM，因為 driver 在極小電流時精度差；二是高亮度用 PWM、低亮度改 DC，用來避免低亮度時的深度調變。選哪一種取決於 LED driver 的最小可控電流、最小 on-time 與色偏規格，要查 driver datasheet 再決定（待查證）。切換門檻（例如 50 cd/m²）與最低亮度目標都是設計值，要實測。

相關程式碼架構示例如下：

```c
#include <stdint.h>

/* 示意地址與介面，非實際晶片規格 */
#define PWM_CTRL_REG          0x1A20
#define PWM_FREQ_REG          0x1A24   /* 16-bit period，高位元組在前 */
#define PWM_DUTY_REG          0x1A28
#define PWM_CTRL_ENABLE       0x80
#define PWM_CTRL_POLARITY     0x01
#define PWM_CTRL_VSYNC_SYNC   0x02     /* 示意：每個 VSYNC 重啟計數 */
#define PWM_CTRL_LATCH        0x04     /* 示意：shadow register 在下個週期生效 */
#define PWM_TIMER_HZ          48000000UL
#define PWM_MULT              25U

extern void Scaler_Write_Register_Byte(uint16_t u16Addr, uint8_t u8Val);

static void PWM_Write_Period(uint32_t u32Period)
{
    /* 先寫 shadow，再 latch，避免高低位元組只寫一半時輸出錯誤週期 */
    Scaler_Write_Register_Byte(PWM_FREQ_REG, (uint8_t)(u32Period >> 8));
    Scaler_Write_Register_Byte(PWM_FREQ_REG + 1, (uint8_t)(u32Period & 0xFF));
    Scaler_Write_Register_Byte(PWM_CTRL_REG,
        PWM_CTRL_ENABLE | PWM_CTRL_POLARITY | PWM_CTRL_VSYNC_SYNC | PWM_CTRL_LATCH);
}

/* 設定 PWM 3.6 kHz：48 MHz / 3600 = 13333.3，取 13333（0x3415），約 277.78 µs。
 * 取整後實際頻率約 3600.09 Hz，不是剛好 25 倍；靠 VSYNC 重啟消除累積相位漂移。 */
void Backlight_PWM_Init_3k6Hz(void)
{
    PWM_Write_Period(13333U);
}

/* 依目前更新率設定 PWM 週期；回傳 0 表示參數不合法、維持原設定 */
int Backlight_PWM_Update_For_VRR(uint16_t u16RefreshRateHz)
{
    uint32_t u32TargetPwmHz;
    uint32_t u32Period;

    if (u16RefreshRateHz == 0U) {
        return 0;                       /* 避免除以 0 */
    }
    u32TargetPwmHz = (uint32_t)u16RefreshRateHz * PWM_MULT;
    u32Period = (uint32_t)(PWM_TIMER_HZ / u32TargetPwmHz);
    if (u32Period > 0xFFFFUL) {
        return 0;                       /* 約 29 Hz 以下會超出 16-bit */
    }
    PWM_Write_Period(u32Period);
    return 1;
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。以下數值是示意。

在某款 27 吋 4K 144 Hz Mini-LED 顯示器 DVT 階段，測試團隊回報：
1. 客訴現象：在黑夜星空遊戲場景與灰階漸層測試畫面中，螢幕暗部出現移動的橫向亮暗帶與微弱閃爍。
2. 量測發現：用光電探頭量光輸出，480 Hz 背光 PWM 和 144 Hz 面板更新率沒有整數倍關係，光波形出現 48 Hz 的包絡（|480 − 3 × 144| = 48）；同時 8-bit + 2-bit FRC 在 0–16 灰階時，背光 duty 很低，低灰階出現階梯狀截斷。
3. 除錯過程：
   - 最初懷疑是 Scaler 端的 Gamma table 精度不足，嘗試調整 10-bit Gamma 曲線無效。
   - 透過光電探頭（Photo Detector）與示波器同步抓取 VSYNC 與背光 PWM 輸出，才抓出差頻根因。
   - 最終將 PWM 頻率提升至 144 Hz × 25 = 3600 Hz 並開啟 VSYNC 同步，在 Scaler 引入 spatial-temporal dithering 搭配 BL_GAIN_LUT，條帶與閃爍消失。

## 新人避坑指南

1. 不要把 PWM 頻率寫死成固定的 480 Hz 或 1 kHz：面對 VRR（例如 48–144 Hz）機種，PWM 要和 VSYNC 同步並維持整數倍；另一條路是把 PWM 拉到遠高於更新率的頻率，讓差頻落在看不到的範圍，但要付出切換損耗與最小 duty 的代價。
2. 注意面板 TCON 與 Scaler FRC 的職責劃分：若 Scaler 已經做了 FRC，面板 TCON 又二次做 FRC，兩者若未協同，會加劇低灰階量化誤差。要先確認 TCON 的輸入位元深度與 FRC 設定，再決定 Scaler 端做 10-bit 到 8-bit 的截斷與 dithering。
3. DC 與 PWM 混合切換的平滑度：切換時要注意 LED 驅動 IC 的 V-I 非線性，避免切換瞬間出現肉眼可見的亮度跳變（Brightness Pop）。

## 思考題

當面板支援 DSC（Display Stream Compression）時，Scaler 輸出的像素時脈與 FRC 處理單元的 pipeline 延遲，是否會影響 Spatial Dithering 的 Bayer matrix 空間對齊？請查閱 VESA DSC 規範。

## 參考資料

- IEEE Std 1789-2015 頻率與調變深度建議摘要：DOE SSL Postings，2015-06-11（https://www.energy.gov/sites/prod/files/2015/06/f22/postings_06-11-15.pdf ）；IEEE 原文條文頁碼待查證。
- Wikipedia，Ordered dithering（Bayer matrix 邊長為 2 的次方、blue noise／void-and-cluster）：https://en.wikipedia.org/wiki/Ordered_dithering
- 差頻與 PWM 週期計算：本文 calc/beat.txt（480／144 Hz 混疊 48 Hz；48 MHz／3600 = 13333.3）。
- TÜV Rheinland Flicker Free Test Criteria（certipedia.com/keywords/1830）
- 以下兩篇談動態模糊（MPRT／GtG），與本文主題相關性較低，保留作延伸閱讀：Blur Busters GtG vs MPRT FAQ（blurbusters.com/gtg-versus-mprt-frequently-asked-questions-about-display-pixel-response/）；TFTCentral MPRT（tftcentral.co.uk/articles/why-moving-picture-response-time-mprt-specs-can-be-misleading）
