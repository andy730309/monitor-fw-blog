---
layout: post
title: "螢幕充筆電十幾秒就斷？USB PD 3.2 EPR 的線材檢查、KeepAlive 與功率預算"
date: 2026-11-03
tags: [USB-PD, EPR, AVS, USB-Type-C, Power-Budget]
level: intermediate
prerequisites: ["顯示器系統方塊圖入門：Scaler、T-CON、Panel、Backlight、PD、Hub 是怎麼分工的？", "影像介面總覽：VGA / DVI / HDMI / DisplayPort / USB-C 的差異與演進"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-03
description: "螢幕用 USB-C 充筆電十幾秒就斷？拆解 USB PD 3.2 EPR 的線材檢查、EPR_KeepAlive 與 monitor 共用電源的功率預算。"
seo_title: "螢幕充筆電會斷？USB PD 3.2 EPR 三個坑"
difficulty: intermediate
---
> **重點摘要**：EPR 把 USB PD 的上限從 100W 拉到 240W，但進入 EPR 前要確認對方宣告 EPR Mode Capable、線材 e-marker 能承受，進入後 sink 還要定期送 EPR_KeepAlive。螢幕的 panel、scaler 與 hub 和筆電共用同一個電源。PDO 不能直接照 adapter 銘牌宣告。

## 前置知識

把 USB PD 想成螢幕和筆電在談一筆用電合約。SPR（Standard Power Range）是大家熟悉的舊合約，最高 100W，用 20V/5A 跑。EPR（Extended Power Range）是把上限拉到 240W 的新合約，多了 28V、36V、48V 三個固定檔，各自對應 140W、180W、240W（USB-IF charger page）。

但這筆合約不是喊價就成立。簽約前要先確認三件事：對手的資格、線材能不能承受、簽完之後雙方還活著。對手的資格是筆電在 Request 裡宣告 EPR Mode Capable；線材要靠 e-marker 宣告可承受 50V/5A（GRL）；簽完之後 sink 要週期送 EPR_KeepAlive，source 回 ACK，source 端一段時間沒收到訊息就 Hard Reset（GRL、TI slypa55）。

另一個常被忽略的觀念是「共享總電盤」。USB-IF 對 monitor 的情境寫得很明白：接牆電的螢幕可以一邊供電、一邊充筆電，同時繼續顯示。這句話的另一面是，adapter 的額定不是全部都可以借給筆電，panel、scaler、hub、downstream USB port 都掛在同一個電盤上。

EPR 期間的可調電壓叫 AVS（Adjustable Voltage Supply），範圍從 15V 到來源端最大固定電壓，step 是 100mV（USB-IF charger page、TI slypa55）。SPR 的可調電壓叫 PPS（Programmable Power Supply），step 是 20mV（TI slypa55）。兩個名字很像，換算方式差一個數量級。

## 技術核心

### 先分清楚四種供電模式

| 模式 | 電壓 | step | 上限 | 出處 |
|---|---|---|---|---|
| SPR 固定 | 5V / 9V / 15V / 20V | 不適用 | 100W（20V/5A） | USB-IF charger page |
| EPR 固定 | 28V / 36V / 48V | 不適用 | 140W / 180W / 240W | USB-IF charger page |
| PPS | 可調 | 20mV | 屬 SPR | TI slypa55 |
| AVS | 15V 到最大固定電壓 | 100mV | 屬 EPR | USB-IF charger page、TI slypa55 |

表格裡的「上限」是該檔位搭配 5A 的結果，實際可給多少要看來源端 PDO 與線材能力，不是看到 48V 就等於 240W。

### EPR 進入流程：source 不能只會點頭

依 GRL 對 PD 3.1 EPR 流程的整理，順序如下：

1. 雙方先建立 SPR 的 explicit contract，並在 Source Capabilities 與 Request 中各自宣告 EPR Mode Capable。
2. Sink 送 EPR_Mode_Enter。
3. Source 回 EPR_Mode_Enter Acknowledged。
4. 非帶線產品，Source 對線材做 Discover Identity，確認線材宣告 50V/5A；帶線產品可直接進下一步。
5. Source 送 EPR_Mode_Enter Succeeded。
6. Source 送 EPR_Source_Capabilities，PDO#1–#7 放 SPR、PDO#8–#13 放 EPR。
7. Sink 回 EPR_Request，Source 回 Accept，調整電壓後送 PS_RDY。

這段整理出自 GRL 以 PD 3.1 為底的技術文章；USB-IF 目前文件是 R3.2 V1.2（2026-09-14），3.2 是否改動流程待查證。

把這串畫成時序，重點在「線材檢查」卡在 Acknowledged 與 Succeeded 之間：

![圖 1．EPR 進入與線材檢查時序](/monitor-fw-blog/assets/img/posts/usb-pd32-epr-avs-monitor-source-power-budget/fig-1.svg)

圖 1．EPR 進入與線材檢查時序

### 坑一：把 capable 當成 allowed

最常見的寫法是把 `sink_epr_capable` 與 `cable_epr_capable` 合成一個 bool，收到 Enter 就回 Succeeded。這樣一來，一條只標 100W 的線也會被加壓到 28V。正確做法是把線材狀態獨立出來，沒拿到 SOP' 的 50V/5A 宣告就回 Enter_Failed。

```c
/* 示意程式碼；控制訊息型別數值待查證 */
if (!g_epr.sink_epr_capable) {
    pd_send_ctrl(PD_CTRL_REJECT);
    return;
}
if (!pd_is_captive_cable()) {
    g_epr.state = EPR_WAIT_CABLE_ID;
    pd_send_discover_identity_sop_prime();
    return;              /* 還不要送 Succeeded */
}
pd_send_epr_mode(EPR_MODE_ENTER_SUCCEEDED);
```

### 坑二：KeepAlive 被主迴圈餓死

EPR 期間 sink 要週期送 EPR_KeepAlive，source 回 ACK 並重置 SourceEPRKeepAliveTimer；source 端 timeout 就 Hard Reset（GRL）。TI 的簡報把容忍度寫成 1 秒：來源端 1 秒內沒看到任何訊息就視為 fault（TI slypa55）。

韌體如果把 PD 協定處理放在 super-loop，和 OSD、EDID 重寫、HPD toggle、panel init 共用同一個 task，只要有一次流程阻塞超過 1 秒，KeepAlive 就來不及處理。症狀是「插著十幾秒後掉回 5V，重插又正常」，因為不是每次都會撞到背景流程。

修正不是把 timeout 調大，而是把 PD 協定服務放到獨立 timer 或高優先 task，並且用 last_rx 時間戳判斷：

```c
/* 10ms 週期；示意程式碼 */
if ((now_ms - g_epr.last_rx_ms) > EPR_KEEPALIVE_FAULT_MS) {
    g_epr.state = EPR_FAULT;
    pd_hard_reset();
}
```

### 坑三：PDO 直接照 adapter 銘牌，AVS 又拿 PPS 的 step 算

adapter 180W 不等於可以對外給 180W。panel、scaler、hub、downstream 與線損都要先扣掉，剩下的才是可對外預算：

```text
可對外 = adapter 額定 - (panel + scaler) - hub/downstream reserve - 線損 reserve
```

以下是設計假設的示意表，不是量測值，也不是規格值：

| 項目 | 示意值 | 說明 |
|---|---|---|
| adapter 額定 | 180W | 假設 |
| panel + scaler | 45W | 假設 |
| hub / downstream reserve | 25W | 假設 |
| 線損 reserve | 10W | 假設 |
| 可對外 | 100W | 180 − 45 − 25 − 10 |

100W 只能停在 20V/5A 的 SPR，不能宣告 28V/5A（140W）。宣告了，重載就是 OCP 或 UVLO，adapter hiccup，PD 合約反覆重建。

AVS 則是另一個獨立的坑。AVS 是 100mV step，PPS 是 20mV step，拿 PPS 的換算函式去算 AVS，欄位落點會差一個數量級：

```c
/* 示意程式碼；AVS 欄位編碼待查證 */
#define AVS_MIN_MV   15000u
#define AVS_MAX_MV   48000u
#define AVS_STEP_MV  100u

uint16_t avs_code_from_mv(uint16_t mv)
{
    if (mv < AVS_MIN_MV) mv = AVS_MIN_MV;
    if (mv > AVS_MAX_MV) mv = AVS_MAX_MV;
    return (uint16_t)((mv - AVS_MIN_MV) / AVS_STEP_MV);
}
```

### 合規面：CTS 不能只跑 SPR

USB-IF 的 PD Compliance Test Specification 要求 PD 產品把 Physical Layer、Protocol、Power Supply 全部 sections 跑完；EPR 產品要用支援 EPR 的方案，例如 GRL USB-PD-C2-EPR、Teledyne LeCroy Voyager M310e、Ellisys Explorer 350（USB-IF Type-C 測試頁）。只跑 SPR 就進 DVT，等於把 EPR 行為留給實驗室幫你發現。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 32 吋 4K 一線通機種，規格寫 PD 140W。DVT 預測試出現三個症狀。第一個是筆電協商到 28V/5A 後十幾秒掉回 5V，作業系統顯示未充電，重插又正常。第二個是換一條只標 100W 的線，螢幕仍然答應 EPR，量到 Vbus 拉到 28V，接頭溫升明顯。第三個是同時掛兩個隨身碟與一顆外接 SSD，負載一拉 adapter 就 hiccup。

量測先把時間軸抓出來：Hard Reset 前最後一筆訊息與時間差，對上韌體裡 EDID 重寫的執行時間，剛好超過 1 秒。協定層分析則看到 Enter Acknowledged 之後直接跳 Enter Succeeded，中間沒有 SOP' 的 Discover Identity。功率量測更直接，adapter 輸出在 SSD 啟動瞬間掉到 UVLO 以下。

三個症狀對應三個根因：線材狀態沒有獨立、KeepAlive 服務被 super-loop 餓死、PDO 沒有扣共享預算。第一個是安全與認證問題，第二個是使用者體驗，第三個是電源設計與韌體的交界。三個都不是「換一條線」可以結案的。

## 新人避坑指南

- 看到 EPR capable 不等於可以進 EPR。capable 是宣告，allowed 要經過線材檢查與預算檢查。
- 線材 identity 用 SOP' 讀，不要用 SOP 的結果推論。沒有 e-marker 或讀不到，就當不支援 EPR。
- KeepAlive 的處理點要放在中斷或高優先 task。super-loop 只能做事後補償，救不了 1 秒的 deadline。
- 建一張功率預算表，每個數字標「量測」或「假設」。不要把 adapter 銘牌直接複製成 PDO。
- AVS 與 PPS 分開實作。100mV 與 20mV 不是同一個換算。
- EPR 產品送測要用支援 EPR 的方案，三個 section 都要跑。
- 熱插拔、睡眠喚醒、筆電關機後重進 EPR 都要测。這三個情境最容易踩到 keep-alive 與 cable identity 的時序。
- dead-battery 筆電先給 5V 再談 EPR，不要一上電就送 EPR_Source_Capabilities。

## 思考題

一台 monitor 的 adapter 額定 180W，panel + scaler 45W，hub 與 downstream reserve 25W，線損 reserve 10W。請問這台螢幕能不能宣告 28V/5A 的 EPR 固定檔？如果筆電同時要求 AVS 20V/3A，加上一顆 5W 的外接 SSD，預算夠不夠？

<details>
<summary>答案</summary>

可對外預算 = 180 − 45 − 25 − 10 = 100W。28V × 5A = 140W，超過 100W，所以不能宣告 28V/5A；只能停在 20V/5A 的 SPR。

AVS 20V × 3A = 60W，加 5W 是 65W，小於 100W，夠用。但要注意 AVS 的電壓換算用 100mV step，不是 PPS 的 20mV。
</details>

## 參考資料

- USB-IF, USB Charger (USB Power Delivery)，官方：https://www.usb.org/usb-charger-pd
- USB-IF, Document Library, USB Power Delivery R3.2 V1.2（2026-09-14），官方：https://www.usb.org/document-library/usb-power-delivery
- USB-IF, USB Type-C / USB Power Delivery Testing Index，官方：https://www.usb.org/usbc
- Granite River Labs, USB-IF PD 3.1－EPR 規格與進出 EPR Mode 的程序，非官方（測試實驗室技術文章）：https://www.graniteriverlabs.com/zh-tw/technical-blog/application-notes-epr-mode
- Texas Instruments, Webinar: USB-C: Global mandates and the new USB Power Delivery 3.1 Extended Power Range（slypa55），製造商簡報：https://www.ti.com/lit/ml/slypa55/slypa55.pdf
- Linux kernel documentation, USB Type-C connector class，官方：https://www.kernel.org/doc/html/latest/driver-api/usb/typec.html
