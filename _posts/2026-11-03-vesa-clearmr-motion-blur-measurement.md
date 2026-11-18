---
layout: post
title: "ClearMR 不是 FW 能刷出來的數字：VESA 動態模糊量測與 CMR 階級新人指南"
date: 2026-11-03
tags: [ClearMR, VESA, motion blur, CMR, certification]
level: intermediate
prerequisites: ["色彩入門：RGB/gamma/色溫/色域", "Overdrive table 與 VRR 下的 variable overdrive"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-03
difficulty: intermediate
---
## 前置知識

顯示器的「動態模糊」不是單一數字能說清楚的。舊規格常用 MPRT（Moving Picture Response Time，動態畫面回應時間）或 GTG（Gray-to-Gray，灰階到灰階）來描述，但這兩者都有盲點：MPRT 只看亮度從 10% 爬到 90% 的時間，沒把整個發光過程算進去；GTG 只關心兩個灰階之間的切換速度，沒說清楚人眼追蹤移動物體時實際看到的模糊程度。

VESA 在 2022 年推出 ClearMR（Clear Motion Ratio Compliance Test Specification），定義一個新指標叫 CMR（Clear Motion Ratio，清晰動態比）。CMR 的概念很直接：用高速鏡頭拍下螢幕上移動的測試圖案，統計「清晰像素」與「模糊像素」的比值，比值越高代表動態越清晰。例如 ClearMR 7000 意味著清晰像素是模糊像素的 65–75 倍（6500–7500 百分比）。

FW 工程師需要理解的重點是：CMR 是量測結果，不是 FW 參數。你不能在韌體裡寫一個 register 把 CMR 從 6000 改成 9000。FW 能做的，是把 Overdrive 邊界、背光 Duty、背光 strobing 開關等設定調到符合 CTS 測試條件，讓產品在 ATC（Authorized Test Center，授權測試中心）的量測下穩定落在目標階級。

## 技術核心

### CMR 階級與 CMR 區間

VESA ClearMR 的標章分為多個效能階級，每個階級對應一個 CMR 區間。以下數據來自 VESA ClearMR 官方效能準則頁面：

| ClearMR 階級 | CMR 區間 |
|---|---|
| 3000 | 2500 ≤ CMR < 3500 |
| 4000 | 3500 ≤ CMR < 4500 |
| 5000 | 4500 ≤ CMR < 5500 |
| 6000 | 5500 ≤ CMR < 6500 |
| 7000 | 6500 ≤ CMR < 7500 |
| 8000 | 7500 ≤ CMR < 8500 |
| 9000 | 8500 ≤ CMR < 9500 |
| 10000 | 9500 ≤ CMR < 10500 |
| 11000 | 10500 ≤ CMR < 11500 |
| 12000 | 11500 ≤ CMR < 12500 |
| 13000 | 12500 ≤ CMR < 14000 |
| 15000 | 14000 ≤ CMR < 16500 |
| 18000 | 16500 ≤ CMR < 19500 |
| 21000 | 19500 ≤ CMR |

2024 年底 VESA 新增了 15000、18000、21000 三個高階級，主要針對 480Hz 以上的超高刷新率顯示器。ClearMR 21000 是目前最高階級。

### 測試條件上限（CTS）

ClearMR CTS 規定了幾個必須滿足的測試條件，FW 端需要特別注意：

- **Luminance Degradation (LDEGRADE)**：≥ 0.50，在最大幀率下
- **Overshoot_max**：≤ 0.20，在最大幀率下（PPFCEIL）
- **Undershoot_max**：≤ 0.010，在最大幀率下（PPFCEIL）
- **Backlight Strobing**：建議關閉，若可能則 Disable，以建立公平比較基準
- **高速鏡頭**：≥ 1000 fps（Camera fps）

測試在環境室溫、預設上電設定、原生解析度、最大幀率、預熱後進行。這意味著 FW 的預設模式（出廠預設）就是測試模式，不能靠使用者手動切到某個「認證模式」才達標。

### FW 端可調的參數

FW 無法直接設定 CMR，但可以透過以下參數影響量測結果：

1. **Overdrive 表**：OD 太弱會造成拖影（模糊像素增加），OD 太強會造成 overshoot/undershoot（邊緣出現光暈或暗邊）。CTS 上限是 overshoot ≤ 20%、undershoot ≤ 1%，FW 需要在這個邊界內找到最佳 OD 曲線。

2. **背光 Duty**：Mini-LED 或 LCD 背光的 PWM Duty 會影響亮度穩定性。CTS 建議固定為最大 Duty，避免動態調光干擾量測。

3. **背光 strobing**：若面板支援背光 strobing（類似黑框插入），CTS 建議在測試時關閉。FW 預設若開啟 strobing，會讓量測結果與未開啟的產品無法比較。

以下是示意性的 FW 修正邏輯，暫存器地址與 Macro 名稱皆為示意，非實際晶片規格，需對照手上的 NDA Scaler SDK：

```c
/* 示意地址，非實際晶片規格 */
#define SCALER_BL_STROBE_EN_ADDR  0x1F84   /* 示意地址，非實際晶片規格 */
#define SCALER_OD_LIMIT_REG       0x1F44   /* 示意地址，非實際晶片規格 */
#define SCALER_BL_DUTY_ADDR       0x1F80   /* 示意地址，非實際晶片規格 */

void clearmr_certification_mode_enable(void)
{
    /* 關閉背光 strobing，符合 CTS 測試條件 */
    Scaler_Write_Register_Byte(SCALER_BL_STROBE_EN_ADDR, 0x00);

    /* 啟用 OD 過沖限制，避免 overshoot > 20% */
    Scaler_Write_Register_Byte(SCALER_OD_LIMIT_REG, 0x01);

    /* 固定背光 Duty 為 100% */
    Scaler_Write_Register_Byte(SCALER_BL_DUTY_ADDR, 0xFF);

    scaler_lock_native_resolution_max_refresh();
}
```

DDC/CI 位址 0x37 已查證（VESA MCCS / ddcutil 文件）；但上述 VCP 代碼（例如 0xE0）為示意，非實際 VESA MCCS 規格，需查證。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某品牌客戶在 DVT 階段送了一款 240Hz 遊戲顯示器去 VESA ATC 做 ClearMR 預測試。內部自測以為能拿 ClearMR 9000，結果 ATC 回報只到 ClearMR 6000，且 overshoot 超標。韌體團隊追查後發現兩個根因：

1. **Overdrive 被調太猛**：為了讓動態畫面看起來更銳利，FW 把 OD 表推到極限，導致移動邊緣的 overshoot 超過 CTS 規定的 20% 上限。ATC 的判定標準是「所有測試條件必須同時滿足」，overshoot 一超標，整個 CMR 數字都不被採認，產品連最低的 ClearMR 3000 都拿不到。

2. **背光 strobing 預設開啟**：該機種出廠預設開啟背光 strobing 來減少動態模糊，但 CTS 規定測試時應關閉 strobing。FW 沒有提供「認證模式」來關閉 strobing，導致 ATC 量測時無法建立公平比較基準。

修正方式：FW 新增一個認證模式，關閉背光 strobing、固定背光 Duty 為 100%、將 Overdrive 限制在不造成 overshoot > 20% 的安全範圍，並鎖定原生解析度與最大幀率。重新送測後，產品穩定落在 ClearMR 7000 階級。

## 新人避坑指南

1. **不要以為 FW 能直接刷 CMR 數字**：CMR 是高速鏡頭拍攝後的統計結果，FW 能做的是調整 Overdrive、背光 Duty、strobing 開關等間接影響量測條件。

2. **CTS 上限是硬門檻**：overshoot ≤ 20%、undershoot ≤ 1% 不是建議值，是必須滿足的條件。超過這個上限，CMR 數字直接作廢。

3. **預設模式就是測試模式**：CTS 規定在預設上電設定下測試。不要指望使用者手動切到某個隱藏模式才達標，FW 的出廠預設必須已經符合測試條件。

4. **送測前先做 pre-compliance**：在送 VESA ATC 之前，先用自有設備（高速鏡頭、色度計）做內部預測試，確認 CMR 落在目標階級區間，且 overshoot/undershoot 都在上限內。

5. **NDA 規格優先**：ClearMR CTS 全文需 VESA 會員或 NDA 才能取得，公開網頁僅有摘要。寫 FW 時務必對照手上的 NDA 規格逐條核對，不要以公開摘要為最終依據。

## 思考題

ClearMR CTS 規定測試時應關閉背光 strobing，但有些 OLED 面板的自發光特性讓「背光 strobing」這個概念本身就不適用。請查 ClearMR CTS 規範，針對 OLED/WOLED/QD-OLED 面板，測試條件是否有特別差異？如果沒有差異，FW 端應該如何處理？

<details>
<summary>提示（點擊展開）</summary>
參考 VESA ClearMR FAQ 與 CTS r1.1 關於 display technology independence 的描述，以及背光 strobing Disable 的條件。
</details>

## 參考資料

1. VESA，「VESA Adds New Performance Levels to ClearMR and DisplayHDR True Black Standards to Support Display Technology Advances for Gamers and Content Creators」，2024-12-30，https://vesa.org/featured-articles/vesa-adds-new-performance-levels-to-clearmr-and-displayhdr-true-black-standards-to-support-display-technology-advances-for-gamers-and-content-creators/（官方）
2. VESA ClearMR，「Performance Criteria」，https://www.clearmr.org/performance-criteria/（官方，含 CMR 階級表與測試條件上限）
3. VESA，「VESA Brings Clarity to Motion Blur in Digital Displays with New Compliance Test Specification and Logo Program」，2022-08-22，https://vesa.org/press/vesa-brings-clarity-to-motion-blur-in-digital-displays-with-new-compliance-test-specification-and-logo-program/（官方）
4. VESA ClearMR Compliance Test Specification (CTS) Revision 1.1，2023-10-17，https://app.box.com/s/vcocw3z73ta09txiskj7cnk6289j356b/file/1336957924550（公開連結，需確認是否為官方授權鏡像）
5. VESA ClearMR FAQ，https://www.clearmr.org/faq/（官方，參考 IDMS v1.1 Chapter 12.3）
