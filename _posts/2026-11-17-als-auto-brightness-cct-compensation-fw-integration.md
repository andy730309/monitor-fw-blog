---
layout: post
title: "ALS 自動亮度與色溫補償：從 flicker 客訴到可量產的 FW 整合"
date: 2026-11-17
tags: [ALS, Auto Brightness, CCT, Backlight, PWM, Color]
level: intermediate
prerequisites: ["背光 PWM 頻率與 bit depth", "色彩入門：RGB、gamma、色溫、色域"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-17
difficulty: intermediate
---
## 前置知識

環境光感測器（Ambient Light Sensor，ALS）量測的是照度，單位 lux，典型範圍從暗光小於 50 lux 到正午超過 10000 lux（Wikipedia，引用 George Mastorakis 2015）。顯示器韌體用它做兩件事：Auto Brightness（依環境光調整背光）與 Auto Color Temperature（依光源補償色溫）。

一個常見的誤解是把 ALS 當成「亮度計」直接驅動 PWM。實際上 ALS 讀值會抖動（抖動幅度依 sensor、增益、積分時間與光源而定，要用實機量；本文不給特定料號的數字），而人眼對亮度的感知是非線性的（例如 CIE L* 近似立方根關係；gamma 2.2 是編碼曲線，不是感知模型）。直接把 lux 線性映射到 PWM duty，暗室這一段只分到很小的 duty 範圍，同樣 1% 的 duty 變化在低亮度時看起來比高亮度明顯得多，讀值一抖，使用者看到的就是亮度跳動。

色溫部分，D65 白點是 x=0.3127、y=0.3290；色溫偏差以 Δuv 與 CCT 表示。多數 ALS 只能量照度（或 broadband + IR），無法精確判斷光源 CCT，直接套 CCT offset 容易把暖光補成冷光。

類比：ALS 就像汽車的光感應大燈，但如果你讓大燈亮度跟著每一個路燈的閃爍即時跳動，乘客會吐。正確做法是加濾波、遲滯與緩變，讓亮度「慢慢跟、不抖動」。

## 技術核心

### 1. ALS 讀值先濾波，再映射

ALS 的 I2C 讀值會抖動，必須先做 IIR 或移動平均濾波，濾波後的值才拿去映射。ams TSL25911 的 I2C 位址是 0x29、供電 2.7–3.6 V、雙光二極體架構、動態範圍 600M:1、最高靈敏度 188 µLux（ams 產品頁，2026-11-18 核對）。濾波要用定點小數，不要用整數除法：`(raw − filtered) / 8` 在差距小於 8 時永遠是 0，會留下最多 7 個 count 的死區，暗室讀值小，這個死區正好吃掉整段有效範圍。Vishay VEML7700 也是常見的高精度 ALS，原廠有「Designing the VEML7700 Into an Application」應用筆記。

### 2. 亮度曲線必須單調且在感知域設計

lux→duty 的映射曲線必須嚴格單調（duty 隨 lux 單調遞增），且建議在感知域（log lux 或 gamma 域）設計。暗室最低亮度不要設 0，避免全黑造成使用者不適。80–120 lux 區間 duty 先升後降是查表或插值寫反的典型症狀。

### 3. hysteresis + slew rate 消除 flicker

在閾值附近加遲滯（hysteresis），避免來回跳動；每次 commit 限制最大變化量（slew rate），讓亮度緩變。兩者閾值需實測校正，本篇給的數值為個人經驗推論。

### 4. CCT 補償限幅

CCT 補償幅度必須限幅，暗室不補償（避免低亮度下色偏被放大），高照度下收斂。若 ALS 只能量照度，CCT 補償效果有限，應考慮 color sensor（RGB/XYZ）。

### 5. ALS 更新與 PWM 更新對齊

背光更新要對齊 vblank，避免畫面中途改亮度。另外 ALS 的積分時間會「看到」市電燈光的 100／120 Hz 閃爍與自家背光漏光，積分時間最好涵蓋整數個閃爍週期（例如 50 ms、100 ms），並注意 sensor 位置與遮光（設計建議，依 sensor datasheet 調整）。

### 示意程式碼

```c
/* 示意地址，非實際晶片規格 */
#include <stdint.h>

#define REG_ALS_DATA_HI    0x1B000008u
#define REG_ALS_DATA_LO    0x1B000004u
#define REG_BL_PWM_DUTY    0x1C000000u
#define REG_CCT_OFFSET     0x1D000000u
#define REG_DISPLAY_COMMIT 0x1E000000u

extern uint8_t Scaler_Read_Register_Byte(uint32_t addr);          /* 示意 */
extern void    Scaler_Write_Register_Byte(uint32_t addr, uint8_t v); /* 示意 */

/* 以下數值都是設計值，需實測校正 */
#define ALS_IIR_SHIFT   3   /* IIR 係數 1/8 */
#define ALS_FRAC_BITS   8   /* 定點小數位，避免整數除法截斷造成穩態誤差 */
#define DUTY_HYST       2   /* 目標與目前差距小於 2%，不動作（遲滯） */
#define DUTY_SLEW_MAX   1   /* 每次 commit 最多改 1%（slew rate） */

/* 單調查表：lux 斷點取對數間距，duty 嚴格遞增，暗室最低 5% 而不是 0 */
static const uint16_t k_lux[]  = { 0, 5, 20, 80, 300, 1000, 5000 };
static const uint8_t  k_duty[] = { 5, 10, 20, 35, 60, 85, 100 };
#define LUT_N (sizeof(k_lux) / sizeof(k_lux[0]))

static uint32_t als_acc;        /* 定點累加值：lux << ALS_FRAC_BITS */
static uint8_t  als_init;       /* 用旗標判斷初始化，不拿 0 當哨兵值 */
static uint8_t  duty_current = 50;

static uint16_t als_read_raw(void)
{
    uint8_t hi, lo, hi2;
    do {                        /* 高低位元組之間資料若更新，重讀一次 */
        hi  = Scaler_Read_Register_Byte(REG_ALS_DATA_HI);
        lo  = Scaler_Read_Register_Byte(REG_ALS_DATA_LO);
        hi2 = Scaler_Read_Register_Byte(REG_ALS_DATA_HI);
    } while (hi != hi2);
    return (uint16_t)(((uint16_t)hi << 8) | lo);
}

static uint16_t als_filter(uint16_t lux)
{
    uint32_t x = (uint32_t)lux << ALS_FRAC_BITS;
    if (!als_init) {
        als_acc = x;
        als_init = 1;
    } else if (x >= als_acc) {
        als_acc += (x - als_acc) >> ALS_IIR_SHIFT;
    } else {
        als_acc -= (als_acc - x) >> ALS_IIR_SHIFT;
    }
    return (uint16_t)(als_acc >> ALS_FRAC_BITS);
}

static uint8_t lux_to_duty(uint16_t lux)
{
    unsigned i;
    if (lux >= k_lux[LUT_N - 1])
        return k_duty[LUT_N - 1];
    for (i = 1; i < LUT_N; i++) {
        if (lux < k_lux[i]) {
            uint32_t span = (uint32_t)(k_lux[i] - k_lux[i - 1]);
            uint32_t pos  = (uint32_t)(lux - k_lux[i - 1]);
            return (uint8_t)(k_duty[i - 1] + (k_duty[i] - k_duty[i - 1]) * pos / span);
        }
    }
    return k_duty[LUT_N - 1];
}

void Als_Update(void)
{
    /* raw 換算成 lux 的公式依 sensor datasheet（增益、積分時間），此處假設已換算 */
    uint16_t lux    = als_filter(als_read_raw());
    uint8_t  target = lux_to_duty(lux);
    int      diff   = (int)target - (int)duty_current;

    if (diff > -DUTY_HYST && diff < DUTY_HYST)
        return;                                     /* 遲滯：小變化不動 */
    if (diff > DUTY_SLEW_MAX)  diff = DUTY_SLEW_MAX; /* slew rate：一次只走一步 */
    if (diff < -DUTY_SLEW_MAX) diff = -DUTY_SLEW_MAX;
    duty_current = (uint8_t)(duty_current + diff);

    Scaler_Write_Register_Byte(REG_BL_PWM_DUTY, duty_current);
    /* CCT 補償限幅：暗室不補、只在可信範圍內微調（略） */
    Scaler_Write_Register_Byte(REG_DISPLAY_COMMIT, 1); /* vblank 生效（示意） */
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠廣色域機種 DVT 階段導入 Auto Brightness + Auto Color Temperature，驗證收到三條線：暗室 5 lux 下螢幕亮度跳動（flicker），使用者回報眼睛不適；陰天窗邊與暖色檯燈下自動色溫補償把畫面染成偏藍，膚色不自然；量測 ALS I2C 讀值在 100 lux 附近抖動明顯（情境數字為示意），亮度映射曲線在 80–120 lux 區間非單調。

協定層與訊號層都正常，問題鎖定在 scaler 內部的 ALS 讀取、濾波、映射與 CCT 補償路徑。根因：把 ALS 當 GPIO 閾值用（無濾波/hysteresis/slew rate）、亮度映射在線性域、映射曲線非單調、色溫補償過度信任 ALS、ALS 輪詢與 PWM 更新不同步、無使用者偏好與退場。

修正：ALS 讀取 → IIR 濾波 → hysteresis + slew rate → 單調分段亮度曲線 → CCT 補償限幅 → vblank commit。提供 Auto/Manual 切換與偏好記憶。

## 新人避坑指南

- ALS 讀值必須先濾波再映射，濾波後再做 hysteresis 與 slew rate。
- 亮度曲線必須嚴格單調，並在感知域設計；暗室最低亮度 > 0。
- CCT 補償限幅，暗室不補償；必要時改用 color sensor。
- 背光更新對齊 vblank；ALS 積分時間涵蓋整數個市電閃爍週期。
- 提供 Auto/Manual 切換與偏好記憶，使用者偏好優先。
- 產線/驗證加入 ALS 功能測項：暗室、辦公室、窗邊、暖光燈四種光源。
- ALS sensor 位置與遮光：避免被背光漏光影響讀值。

## 思考題

如果你的機種 ALS 只能量照度（broadband + IR），在暖色檯燈下 CCT 補償會把畫面補成什麼顏色？你會如何限制這個風險？（答案請查 ams TSL25911／Vishay VEML7700 datasheet 的光譜響應曲線）

## 參考資料

- Wikipedia「Ambient light sensor」（非官方）：https://en.wikipedia.org/wiki/Ambient_light_sensor
- ams TSL25911 產品頁（官方）：https://ams.com/tsl25911
- Vishay VEML7700 產品頁（官方）：https://www.vishay.com/en/product/84286/
- Vishay 應用筆記「Designing the VEML7700 Into an Application」（官方 PDF）：https://www.vishay.com/docs/84323/designingveml7700.pdf
- sRGB 提案文件（W3C 託管）：https://www.w3.org/Graphics/Color/sRGB
- 內部筆記：knowledge/notes/2026-11-17-als-auto-brightness-cct-compensation-fw-integration.md
