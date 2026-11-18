---
layout: post
title: "OLED 螢幕燒屏怎麼防？顯示器韌體的 pixel shift、ABL 與 pixel refresh 三層防線"
date: 2026-11-04
tags: [OLED, burn-in, pixel-shift, ABL, panel-protection, firmware]
level: intermediate
prerequisites: ["色彩入門：RGB/gamma/色溫/色域", "Scaler FW 架構（MCU core、ISR、task loop/RTOS）通論", "OSD menu table-driven 架構與資源壓縮"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
difficulty: intermediate
---
## 前置知識

OLED（有機發光二極體）面板跟 LCD 不一樣，沒有背光模組，每個像素自己發光（self-emissive）。這意味著每個像素的發光效率都會隨著使用時間與亮度而慢慢衰減。如果某些像素長期顯示靜態高亮度內容（例如遊戲的血條、OSD 選單、桌面任務列），那些像素就會比周圍老得快，結果就是螢幕上留下陰影，這就是 burn-in（燒屏）或 image retention（影像殘留）。

防止 burn-in 的核心思路是「讓每個像素平均用勻、不要讓某些像素一直超載」。顯示器韌體通常靠三層防線來做：

1. **Pixel shift / orbit（像素位移）**：把畫面整體微小位移（幾個像素），讓靜態內容不會長期落在同一組實體像素上。
2. **ABL（Auto Brightness Limiter，自動亮度限制）**：當畫面整體亮度（APL）太高時，動態降低面板驅動電流，避免長期高亮度加速老化。
3. **Pixel refresh / panel refresh（像素刷新）**：累積使用時間達到閾值後，在待機狀態下執行清程序，約 6 分鐘，期間不可斷電。

這三層防線缺一不可，單靠其中一層不足以防止 burn-in。

## 技術核心

### 根因分析

OLED burn-in 的根本原因是像素使用不均勻。每個 OLED 像素的發光材料會隨電流與時間老化，靜態高亮度內容會讓特定區域像素提前衰減，與周圍產生亮度與色差。韌體若沒有 pixel shift、ABL 或定期 pixel refresh，就等於任由局部像素超載。

### 韌體修正程式碼

以下為示意性韌體程式碼，暫存器地址與 Macro 名稱若非出自公開 datasheet，一律標註 `/* 示意地址，非實際晶片規格 */`。DDC/CI VCP code 為 MCCS 公開定義（已查證，參見 ddcutil 文件與 MCCS 規格）。

**Pixel shift/orbit 狀態機（每 vblank 執行）：**

```c
/* 示意地址，非實際晶片規格 */
#define REG_OLED_PROTECT_CTRL     0x1F40
#define REG_OLED_SHIFT_OFFSET_X   0x1F44
#define REG_OLED_SHIFT_OFFSET_Y   0x1F48

#define OLED_PROTECT_PIXEL_SHIFT_EN   (1 << 0)
#define OLED_PROTECT_ABL_EN           (1 << 1)

typedef struct {
    uint32_t cumulative_usage_min;
    uint32_t last_refresh_min;
    int16_t  shift_offset_x;
    int16_t  shift_offset_y;
    uint32_t shift_period_ms;
    uint32_t shift_counter_ms;
    bool     abl_active;
} oled_protect_state_t;

static oled_protect_state_t g_oled_protect;

void oled_protect_vblank_handler(uint32_t apl, bool static_content_detected)
{
    if (static_content_detected) {
        g_oled_protect.shift_counter_ms += VBLANK_INTERVAL_MS; /* 示意：16.67 ms @60Hz */
        if (g_oled_protect.shift_counter_ms >= g_oled_protect.shift_period_ms) {
            g_oled_protect.shift_counter_ms = 0;
            g_oled_protect.shift_offset_x = (g_oled_protect.shift_offset_x + 1) % 4;
            g_oled_protect.shift_offset_y = (g_oled_protect.shift_offset_y + 1) % 4;
            Scaler_Write_Register_Byte(REG_OLED_SHIFT_OFFSET_X, g_oled_protect.shift_offset_x); /* 示意地址 */
            Scaler_Write_Register_Byte(REG_OLED_SHIFT_OFFSET_Y, g_oled_protect.shift_offset_y); /* 示意地址 */
        }
    } else {
        g_oled_protect.shift_offset_x = 0;
        g_oled_protect.shift_offset_y = 0;
        Scaler_Write_Register_Byte(REG_OLED_SHIFT_OFFSET_X, 0); /* 示意地址 */
        Scaler_Write_Register_Byte(REG_OLED_SHIFT_OFFSET_Y, 0); /* 示意地址 */
    }

    if (apl > OLED_ABL_THRESHOLD_HIGH) { /* 示意閾值，待查證 */
        g_oled_protect.abl_active = true;
        Scaler_Write_Register_Byte(REG_OLED_PROTECT_CTRL,
            Scaler_Read_Register_Byte(REG_OLED_PROTECT_CTRL) | OLED_PROTECT_ABL_EN); /* 示意地址 */
    } else if (apl < OLED_ABL_THRESHOLD_LOW) {
        g_oled_protect.abl_active = false;
        Scaler_Write_Register_Byte(REG_OLED_PROTECT_CTRL,
            Scaler_Read_Register_Byte(REG_OLED_PROTECT_CTRL) & ~OLED_PROTECT_ABL_EN); /* 示意地址 */
    }
}
```

**Pixel refresh 觸發邏輯：**

```c
/* 累積使用時間達閾值後觸發 pixel refresh，約 6 分鐘（依 ASUS/BenQ 官方 FAQ） */
/* OLED_REFRESH_THRESHOLD_MIN 為 16 小時 = 960 分鐘（Philips 官方參考，待查證） */
#define OLED_REFRESH_THRESHOLD_MIN   960
#define OLED_REFRESH_DURATION_MIN    6

void oled_protect_check_refresh(uint32_t current_min)
{
    if ((current_min - g_oled_protect.last_refresh_min) >= OLED_REFRESH_THRESHOLD_MIN) {
        /* 進入 standby 後自動執行，不可斷電（ASUS/BenQ 官方說明） */
        Scaler_Write_Register_Byte(REG_OLED_PROTECT_CTRL,
            Scaler_Read_Register_Byte(REG_OLED_PROTECT_CTRL) | (1 << 2)); /* 示意地址 */
        g_oled_protect.last_refresh_min = current_min;
    }
}
```

**DDC/CI VCP 0x10 與 ABL 協調（VCP 0x10 為 MCCS 公開定義，已查證）：**

```c
/* DDC/CI VCP 0x10 亮度：MCCS 公開定義（已查證，ddcutil 文件與 MCCS 規格） */
/* OLED 保護暫存器地址：示意地址，非實際晶片規格 */
bool ddc_ci_set_vcp_0x10(uint8_t brightness)
{
    if (g_oled_protect.abl_active && brightness > OLED_MAX_BRIGHTNESS_ABL) {
        return FALSE; /* ABL 啟動時拒絕 DDC/CI 強制高亮度 */
    }
    Scaler_Write_Register_Byte(REG_BACKLIGHT_DUTY, brightness); /* 示意地址 */
    return TRUE;
}
```

> 上述 `REG_OLED_*` 與 `Scaler_Write_Register_Byte` 皆為示意，非 RTD/Novatek/MStar 真實規格，請對照手上的 NDA datasheet。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 OLED 顯示器機種在 DVT 階段收到客訴：使用者長時間顯示靜態高對比內容（固定 OSD 選單、任務列、遊戲 HUD）後，螢幕出現明顯的影像殘留與燒屏。RMA 分析顯示，面板特定區域發光效率下降，色彩偏移。韌體端並未啟動 pixel shift、ABL 或定期 pixel refresh，導致像素使用不均勻，加速局部老化。

量測現象：靜態圖案對應位置的亮度較周圍低，白場畫面可見明顯色陰。協定層分析：韌體缺乏三層防線，DDC/CI VCP 0x10 亮度指令與 ABL 可能衝突（亮度被強制拉高加速老化）。修正後，ABL 啟動時拒絕 DDC/CI 強制高亮度，並加入累積使用時間觸發的 pixel refresh（約 6 分鐘，不可斷電）。

## 新人避坑指南

1. **不要把 DDC/CI ack 當成執行完成**：VCP 0x10 只回覆 I2C ack 不代表亮度已生效，OLED 保護需與 ABL 協調，避免亮度被強制拉高。
2. **Pixel refresh 不可斷電**：ASUS 與 BenQ 官方皆說明 pixel cleaning 約 6 分鐘，期間若斷電會中斷並可能導致面板狀態不一致，FW 需在 standby 後執行並加上斷電保護。
3. **暫存器地址不要亂寫**：示意程式碼中的 `REG_OLED_*` 皆非真實晶片規格，實際開發必須對照 scaler 供應商的 NDA datasheet。
4. **OSD 靜態元素也是燒屏源**：選單、Logo、HUD 長期高亮度顯示需啟動 Logo Dimming 或 Idle Dimmer，不要只靠 pixel shift。
5. **累積使用時間要存在 NVRAM**：防斷電遺失，否則 pixel refresh 的觸發時機會重置，保護機制形同虛設。

## 思考題

ASUS 官方 FAQ 建議 pixel cleaning 每 4 小時執行一次，BenQ 的 Pixel Refresh 約 6 分鐘，Phil 則在累積 16 小時觸發 pixel refresh、2000 小時執行 panel refresh。這三家廠牌的數值差異這麼大，作為韌體工程師，你應該怎麼決定自家機種的 pixel refresh 觸發閾值？要查哪份文件才能確定？

<details>
<summary>提示（點擊展開）</summary>
沒有統一的 VESA 規格規定 OLED burn-in 保護的時間閾值（目前標「待查證」）。實務上應以面板供應商 NDA datasheet 的建議為準，並結合自家產品的使用場景（桌面顯示器 vs 電視 vs 遊戲螢幕）做 DVT 加速老化測試後鎖定數值。
</details>

## 參考資料

1. ASUS 支援官方 FAQ：[LCD Monitor] ASUS OLED Monitor Protection Mechanism & Warranty Service（Pixel Shift、Screen Saver、Pixel Cleaning 約 6 分鐘、Adjust Logo Brightness），https://www.asus.com/global/support/faq/1048131/（官方，2026/02/24 更新）
2. ASUS 支援官方 FAQ：[LCD Monitor] ROG OLED Gaming Monitor Pixel cleaning process（手動/自動/待機中 pixel cleaning，約 5-6 分鐘），https://www.asus.com/support/FAQ/1053180/（官方，2025/01/10 更新）
3. BenQ 支援官方 FAQ：How can I protect BenQ OLED monitor against image burn-in?（Pixel Refresh 約 6 分鐘、Idle Dimmer、Logo Dimming、Pixel Shift），https://www.benq.com/en-us/support/faq/0125018.html（官方，2026-01-19 更新）
4. Philips 官方支援：How to prevent burn-in on a Philips QD OLED or OLED monitor?（Pixel orbiting、Pixel refresh 16 小時觸發、Panel refresh 2000 小時、Multi-logo protection、Boundary dimmer），https://tv-sound-monitors.philips.com/s/article/Philips-QD-OLED-OLED-screen-care-warranty-1715610567780（官方）
5. panel-display-hardware skill（OLED burn-in 保護：pixel shift/orbit、ABL、pixel refresh/cleaning，數分鐘期間不可斷電，依廠牌）
