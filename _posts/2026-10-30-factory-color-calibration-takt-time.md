---
layout: post
title: "白平衡校正把產線卡死？DDC/CI 等待、verify 與 store 的三個時間陷阱"
date: 2026-10-30
tags: [工廠校正, 白平衡, DDC/CI, MCCS, takt time, CA-410, ddcutil, 量產]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器", "色彩入門：RGB、Gamma、色溫、色域 (sRGB/DCI-P3/Adobe RGB)"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-10-30
description: "白平衡校正站拖慢 takt time？拆解 DDC/CI 等待、setvcp verify 與 store 三個時間陷阱，並說明怎麼量測與縮短。"
seo_title: "白平衡校正卡產線？DDC/CI 等待與 store 時間陷阱"
difficulty: intermediate
---
> **重點摘要**：校正站常是產線瓶頸，因為它既要寫值又要等待。DDC/CI 的 I2C ack 不代表命令已執行，store 也是另一件事。先把時間切成 DDC 等待、pattern 穩定、儀器量測、迭代輪次、store 與重開機驗證五段來量；本案的瓶頸是 DDC 等待與迭代輪次。

## 【前置知識準備】

先把三個名詞講人話。

**takt time（節拍時間）**：產線平均多久出一台。站別的實際時間超過 takt，整條線的產出就被這一站拖住，其他站再快也沒用。校正站（calibration station）通常是色彩相關機種的熱門瓶頸，因為它又要做事、又要等。

**DDC/CI（Display Data Channel Command Interface）**：主機透過 I2C 跟螢幕講話的協定，螢幕端的 slave address 是 0x37（ddcutil 官方文件）。講的內容是 MCCS（Monitor Control Command Set）定義的 VCP code，例如 10h 亮度、16h/18h/1Ah 的 R/G/B gain。可以想成：I2C 是馬路，DDC/CI 是交通規則，MCCS 是公文格式。

用工程類比串起來：你打電話訂貨（DDC/CI），對方櫃檯說「收到了」（I2C 層的 ack），但不代表倉庫真的出貨了（命令執行完成）。電話打完還要等對方回電（規格定的等待時間），而「訂單存檔」是另一件事（store），不是打完電話就算存檔。

這裡有三個會直接吃掉 takt 的時間，全部來自規格與工具文件，不是經驗玄學：

1. **等待時間**：DDC/CI 規格要求主機在送命令與讀回應之間等 40–200 ms，依操作種類不同。ddcutil 文件說，照規格做的 ddcutil「大約 90% 的 elapsed time 都在睡覺」。你沒看錯，九成時間在等。
2. **驗證（verify）**：Set VCP Feature 只拿到「封包被收到」的 I2C ack，沒有任何訊號保證螢幕真的執行了。所以 ddcutil 的 `setvcp` 預設會再讀一次（getvcp）確認，除非你加 `--noverify`。
3. **存檔（store）**：MCCS 的 VCP `B0h Settings` 是 write-only，`0x01` 代表「Store current settings in the monitor」。不送這一下，gain 只活在暫存狀態，重開機就沒了。

## 【系統廠真實血淚案例】

> **情境模擬（依公開規格推演）**：以下為虛構的教學情境，非真實客戶、產品或任何特定廠商的事件。

PVT 量產階段，白平衡校正站的 takt 預算是 60 秒/台（示意），實測平均 95 秒/台，UPH 掉三成。同時客訴（模擬）回報：同批機台色溫離散比規格大，約 3% 的機台「過站時量是好的，出貨前再量就跑掉」，重開機後白點回到未校正值。

產線第一個反應是把等待時間越加越長，結果時間更爆、離散沒變小。抓時間分佈才發現，時間不是花在量測，是花在三件事上：

**根因一：逐特徵寫、等待設滿。** 舊腳本把 R/G/B gain 與 R/G/B black level 六個特徵分六次 `setvcp`，每次都付規格上限的等待。六特徵 × 六輪收斂 ×（寫 + verify 讀）＝ 72 次 DDC 操作，依公開的 40–200 ms 區間推演，光等待就是 2.9 s 到 14.4 s（示意推演，非實測）。但 ddcutil 的 `setvcp` 本來就允許一次帶多組 feature/new-value，`--sleep-multiplier` 也能把 40 ms 變 20 ms，只是縮短等待會提高失敗率，要配合 `--stats tries` 觀察 retry 率才能調（以上均出自 ddcutil 官方文件）。

**根因二：verify 與 store 的順序沒照機種行為排。** 這就是那 3% 跑掉的機制。`setvcp` 只有「收到了」的 ack，所以要 verify；但 ddcutil 的 `scs`（Save Current Settings）頁面記錄了真實存在的怪異行為：特定幾款市售機種的 `setvcp` 必須**緊接** `scs` 才真正生效，這時若不關 verify，setvcp 內部的回讀會在 scs 之前讀到舊值而誤判失敗。反過來說，只寫不存、或存的時機不對，重開機白點就跑掉——這正是客訴看到的症狀。

**根因三：用爬山法做線性題。** 舊腳本「改一點 → 量 → 再改一點」收斂六輪以上。黑平衡（6Ch/6Eh/70h Video black level）與白平衡（16h/18h/1Ah Video gain）本質是兩段式線性問題，量兩點就能解斜率截距，一輪到位。輪次不降，量測次數（尤其最貴的低亮度點）就不會降。

低亮度有多貴？Konica Minolta 官方新聞稿寫：CA-410 保證精度的亮度範圍 0.001–5,000 cd/m²（比前一代寬 25 倍），量到 0.001 cd/m² 需要 1 秒。黑階點拿來當常規檢查，就是在燒 takt。

修正後的流程（示意）：

```python
# 已查證：ddcutil 指令語法與選項（官方文件）
DDC = ["ddcutil", "--sleep-multiplier", "0.5", "--maxtries", "4,6,4"]
# 數字為示意：依站點 --stats tries 實測收斂後再定案

def white_pass(gain):
    # 批次寫：單一 setvcp 帶三組（已查證 ddcutil 支援）
    # 16h Red、18h Green、1Ah Blue（注意是 1Ah，不是 1Bh）
    run(DDC + ["setvcp", "16", str(gain[0]),
                          "18", str(gain[1]),
                          "1a", str(gain[2])])
    # setvcp 預設會 verify；站端再讀一次當 double-check
    ...

def store_and_check(serial):
    run(DDC + ["scs"])     # 已查證：Save Current Settings 存入 nonvolatile storage
    power_cycle()          # 示意：治具切電
    return match_after_reboot(serial)   # 斷電重驗，抓假過站
```

FW 端（monitor 側）的關鍵是三個語意：

```c
/* 已查證：VCP 16h/18h/1Ah = Video gain R/G/B；6Ch/6Eh/70h = Video black level；
 * B0h Settings，0x01 = Store current settings in the monitor（ddcutil vcpinfo、VESA MCCS）。
 * 以下 Scaler 暫存器地址與 NVRAM layout 均為示意，非公開 datasheet。 */
#define VCP_GAIN_B        0x1A   /* 1Ah，不是 1Bh */
#define VCP_SETTINGS      0xB0   /* write-only */
#define VCP_SETTING_STORE 0x01

/* 示意地址，非實際晶片規格 */
#define SCALER_WB_GAIN_R  0x4310

uint8_t Ddc_SetVcpFeature_Handler(uint8_t vcp, uint16_t value)
{
    switch (vcp) {
    case 0x16: case 0x18: case 0x1A:
        Factory_ApplyGainCh(vcp, value);   /* working value 必須馬上可讀 */
        break;
    case VCP_SETTINGS:
        if (value == VCP_SETTING_STORE)    /* 只有 store 才燒 NVRAM，附 CRC */
            Factory_SaveWbWithCrc();
        break;
    default:
        return DDC_RESULT_UNSUPPORTED_VCP; /* 示意錯誤碼 */
    }
    return DDC_RESULT_NO_ERROR;            /* 示意錯誤碼 */
}
```

1. **working value 寫完立刻可讀**：host 的 verify 是緊接著的回讀，任何「下一幀才生效」的實作都會讓 verify 讀到舊值。
2. **B0h/0x01 才是持久化的觸發點**：不是每次 gain 寫入都燒 flash，順帶保護 flash 壽命。
3. **CRC + 序號綁定，開機驗證失敗退回出廠預設**：不要拿半套校正資料上屏。

修正後（模擬情境中）takt 回到預算內，斷電重驗也把那 3% 的假過站抓光。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

- **VCP 16h / 18h / 1Ah（Video gain R/G/B）與 6Ch / 6Eh / 70h（Video black level R/G/B）**：校正在調的主角。Blue 是 `1Ah` 不是 `1Bh`，抄錯的人不少（ddcutil vcpinfo 輸出可查）。
- **VCP `B0h Settings`（write-only，`0x01` store）**：持久化的開關。診斷「重開機跑掉」第一個就查有沒有送這個。
- **DDC/CI 的 0x37（slave address）與 I2C 層 ack**：ack 只代表封包到了，不代表命令執行了。診斷 verify 失敗先分清楚你拿到的是哪一種 ack。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- **先把時間切五段量**：DDC 等待、pattern 穩定、儀器量測、迭代輪次、store+重開機驗證。瓶頸通常不在你直覺的地方，本案是 DDC 等待與輪次。
- **能批次就批次，能一輪就別六輪**：一個 `setvcp` 帶多組 feature；黑/白平衡用兩點閉式解。省的是協定等待與量測次數，兩邊都省。
- **速度與驗證要一起談**：`--noverify` 不是不能用，是用了就要有替代防線（站端 double-check 或斷電重驗）。追求 takt 而砍掉所有驗證，換到的是客訴。
- **retry 要 fail-fast**：ddcutil 預設 write-read 最多 10 次嘗試，邊際治具會讓時間長尾爆炸。設上限、打 NG、把 `--stats tries` 上傳 MES 追蹤治具。
- **量測次數要精打細算**：0.001 cd/m² 單點要 1 秒（Konica Minolta 新聞稿），低亮度點別當常規檢查項；儀器切到最快可用模式（CA-410 的 LTD. AUTO / Single-Frame）。
- **報告看 max 與 95th percentile，不只平均**：平均會掩蓋單點超標，出貨前才爆。

### 3. 思考題

ddcutil 的 `scs` 頁面寫著：多數 display 有實作 Save Current Settings，但「即使有，這個指令通常看不出效果」，而特定機種卻是 `setvcp` 後**必須**緊接 `scs` 才生效。請查 MCCS 正式規格（VESA，full document 需購買，可先對照 VESA 的 MCCS V2.2 新聞稿與 ddcutil 的 vcpinfo 輸出）與你手邊機種的 capabilities string：

1. `scs` 在 MCCS 裡對應的 VCP code 是哪一個（提示：跟 `B0h Settings` 有關）？它的 0x01/0x02 各代表什麼？
2. 為什麼「先 verify 再 store」與「先 store 再 verify」在不同機種上會得出相反的結果？你要怎麼設計一套對兩種行為都成立的流程？
3. 如果某機種的 gain 只寫不存也能過 verify，但斷電就消失——你會把它判定為 FW bug、DDC/CI 實作差異，還是站點腳本 bug？你的判斷依據要查哪一份文件？

答案在 MCCS 的 Preset group 與 ddcutil 文件裡，自己查過一次，下次遇到「量對了卻跑掉」就不會只會怪儀器。

## 參考資料

1. ddcutil Documentation — Performance and Tuning Options（DDC/CI 規格等待 40–200 ms、約 90% 時間在 sleep、--sleep-multiplier、--maxtries 預設 4/10/8、capabilities 快取）— 官方（工具專案文件）：https://www.ddcutil.com/performance_options/
2. ddcutil Documentation — setvcp（I2C 層 ack 與執行 ack 差異、預設 verify、--noverify、單一指令多組 feature/new-value）— 官方（工具專案文件）：https://www.ddcutil.com/command_setvcp/
3. ddcutil Documentation — scs（Save Current Settings 存入 nonvolatile storage、特定機種 setvcp 後需緊接 scs、此時應配 --noverify）— 官方（工具專案文件）：https://www.ddcutil.com/command_scs/
4. ddcutil Documentation — vcpinfo example（VCP 16h/18h/1Ah Video gain、6Ch/6Eh/70h Video black level、B0h Settings 0x01 store）— 官方（工具專案文件）：https://www.ddcutil.com/vcpinfo_output/
5. ddcutil Documentation — DDC vs I2C（DDC/CI 疊在 I2C 上，slave address x37）— 官方（工具專案文件）：https://www.ddcutil.com/ddc_vs_i2c/
6. Konica Minolta 新聞稿 — CA-410 發表（0.001–5,000 cd/m²、比 CA-310 寬 25 倍、0.001 cd/m² 量測 1 秒、64 次 gamma 量測模擬整體時間少 30%）— 官方：https://www.konicaminolta.com/newsroom/2017/pdf/1109-01-01.pdf
7. Konica Minolta CA-410 catalog（LTD. AUTO / Single-Frame、為整合自動系統而設計、probe 校正通道）— 官方：https://www.konicaminolta.com/instruments/download/catalog/display/pdf/ca410_catalog_eng.pdf
8. Chroma — Video & Color Test Solutions（2238 Video Pattern Generator、7123 Display Color Analyzer）— 官方：https://www.chromaate.com/en/test_solutions/video_color_test_solution
9. VESA 新聞稿 PR42009MCCS（MCCS V2.2 為 baseline spec、含 VCP codes 與 compliance requirements、full document 需購買）— 官方：https://www.vesa.org/wp-content/uploads/2010/12/PR42009MCCS.pdf
10. Microsoft Learn — Using the Low-Level Monitor Configuration Functions（VCP continuous/non-continuous、capabilities string 內容）— 官方：https://learn.microsoft.com/en-us/windows/win32/monitor/using-the-low-level-monitor-configuration-functions

提醒：MCCS 與 DDC/CI 正式規格全文需向 VESA 取得（部分需付費），本文只引用公開文件與工具文件；scaler 暫存器與 NVRAM 範例皆為示意，對照你手上的 NDA 文件為準。
