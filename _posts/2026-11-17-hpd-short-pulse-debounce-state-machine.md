---
layout: post
title: "碰一下線材就黑屏、睡醒就沒畫面？DisplayPort HPD 短脈衝與 debounce 的三個坑"
date: 2026-11-17
tags: [DisplayPort, HPD, IRQ_HPD, debounce, DPCD, AUX, 狀態機]
level: intermediate
prerequisites: ["EDID 入門與 edid-decode 實作", "DPCD 與 sink capability", "DisplayPort link training"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-17
description: "碰一下線材就黑屏？DisplayPort HPD 有長脈衝與短脈衝兩種語意。本文說明 debounce 與 sink 端的 HPD 狀態機設計。"
seo_title: "DisplayPort HPD 短脈衝與 debounce 三個坑"
difficulty: intermediate
---
> **重點摘要**：HPD 由螢幕驅動、顯示卡偵測，拉低超過 2 ms 會被當成拔線，拉低 0.5–1.0 ms 則是 IRQ_HPD 事件通知。韌體想通知事件卻拉低太久，畫面就會閃；脈衝太短又可能被忽略。debounce 要用連續取樣確認穩定，並以狀態機管理：連接才拉高，事件只發短脈衝。

## 前置知識

把 HPD（Hot Plug Detect，熱插拔偵測）想成門口的電鈴，就懂這篇文章在講什麼。先講清楚誰按、誰聽：HPD 是 sink（螢幕）驅動、source（顯示卡）偵測的訊號。螢幕是按電鈴的人，顯示卡是聽電鈴的人。

大多數人以為 HPD 很單純：線插著就是高電位，拔掉就是低電位。但 DisplayPort 的 HPD 其實有「兩種按法」。一種是長按：HPD 拉低超過 2 ms，source 會當成拔線再插回（DP 2.0 PDF p.65、p.719）。另一種是短按：拉低 0.5–1.0 ms 再放開，叫 IRQ_HPD（interrupt request HPD），意思是「我有事要跟你說」（PDF p.717）。短按可能是 MST（Multi-Stream Transport，多串流）拓樸變了，也可能是 link 狀態改變，source 收到後要去讀 DPCD（DisplayPort Configuration Data）看發生什麼事。

新手第一個坑就在這裡：如果 FW（韌體，firmware）想通知事件，卻把 HPD 拉低太久，source 會當成拔線，畫面閃一下；反過來，脈衝太短（短於 0.25 ms），source 可以直接忽略（PDF p.717），事件通知就送不出去。同一條訊號線，兩種語意，脈寬決定一切。

第二個觀念是 debounce（去抖動）。螢幕這端要 debounce 的不是 HPD（HPD 是自己輸出的），而是「source 有沒有接上」的偵測輸入，例如線材或 source 電源偵測腳，具體用哪一支依 scaler 而定（待查證）。機械接點在插拔瞬間會來回彈幾下，debounce 的目的不是「延遲一下再讀」，而是「等到訊號和周邊電路都進入可以服務的狀態」。source 那端也有 debounce：DP 2.0 建議 HPD 拉高要連續 100 ms 才確認為連接，而且不要對 IRQ_HPD 與 2–100 ms 的拔插脈衝做 debounce（PDF p.381）。Linux kernel 的 `wait_hpd_asserted` 回呼文件也說，這個函式可能等得比指定的 `wait_us` 還久，因為 DP controller 的 debouncing time 可能很長，重點是回傳成功時代表已經可以送 AUX（Auxiliary Channel，輔助通道）交易。

## 技術核心

### 一、先分清楚 long pulse 與 short pulse

規格時序（DP 2.0）：

- IRQ_HPD：拉低 0.5–1.0 ms；短於 0.25 ms，source 可以忽略（PDF p.717）。
- 拔插事件：拉低超過 2 ms（PDF p.65、p.719）。sink 若要 source 重新偵測（例如 EDID 改了），典型做法是拉低 2–100 ms（PDF p.381）。
- source 端連接 debounce：建議 HPD 連續拉高 100 ms 才確認（PDF p.381）。

Linux kernel 把 source 端的兩條路徑也寫得很清楚，可以對照：

- `drm_helper_hpd_irq_event()`：對所有設了 `DRM_CONNECTOR_POLL_HPD` 旗標的 connector 跑一輪 detect cycle（偵測週期），其他 connector 忽略。這是「連接狀態變了，重新偵測」的路徑。
- `drm_dp_mst_hpd_irq_handle_event()`：driver 偵測到 HPD IRQ 時呼叫，帶入 `DEVICE_SERVICE_IRQ_VECTOR_ESI0` 的值，由 topology manager 處理 sideband 訊息。這是「sink 有事件要通知」的路徑。

sink FW 該做的是：source detect 輸入用 ISR 加 task loop 處理；HPD 輸出則依事件產生正確的脈寬。

### 二、debounce 用「連續取樣穩定」，不要用單一 delay

中斷進來就 `mdelay(20)` 再讀一次準位，是最常見也最危險的寫法：delay 太短吃不掉毛刺，而且在 ISR 或 task 裡阻塞 20 ms，其他事情（例如 AUX 回覆，sink 必須在 300 µs 內開始回，DP 2.0 PDF p.382）都會被拖住。正確做法是每個 tick 取樣一次，連續 N 次一致才算穩定，中間有任何變化就重新計時。

### 三、狀態機：連接才拉高 HPD，事件只發短脈衝

這是整個修正的核心。source 接上且穩定後，先讓 AUX、DPCD、EDID 就緒，最後才拉高 HPD；link training 是 source 讀完 DPCD 後才發起的，sink 不能在 HPD 拉高前自己「先 train 好」。要通知事件時，先寫 DPCD `0x201`（`DEVICE_SERVICE_IRQ_VECTOR`，Linux kernel `drm_dp_helper.c` 有讀寫它），再發 0.5–1.0 ms 的 IRQ_HPD。MST 模式下事件向量在 ESI 區（kernel 的 `DEVICE_SERVICE_IRQ_VECTOR_ESI0`），請依實際模式寫對位置。

```c
/* hpd_sink.c — monitor（sink）端 HPD 輸出與 source detect 輸入（示意架構） */
#include <stdint.h>

/* 以下為 scaler 內部 GPIO／暫存器的示意介面，非實際晶片規格 */
extern int      Scaler_Read_SrcDet_Pin(int port);   /* source／線材偵測輸入，依晶片而定（待查證） */
extern void     Scaler_Set_HPD(int port, int level);
extern void     udelay(uint32_t us);
extern void     dpcd_set_irq_vector(int port, uint8_t bits);   /* 寫 DPCD 0x201 */
extern void     aux_dpcd_edid_prepare(int port);    /* AUX 醒來、DPCD 與 EDID 備妥（示意） */
extern void     link_teardown(int port);

/* 時間常數：IRQ_HPD 與拔插事件引用 DP 2.0；其餘為設計值 */
#define HPD_IRQ_LOW_US       750U  /* IRQ_HPD 拉低 0.5–1.0 ms（DP 2.0 PDF p.717），取中間值 */
#define HPD_REPLUG_LOW_MS    10U   /* 拔插事件 > 2 ms（PDF p.65、p.719）；< 100 ms 避開 source debounce（p.381） */
#define SRCDET_STABLE_TICKS  20U   /* source detect 連續穩定 20 個 1 ms tick（設計值，需實測） */

enum link_state { ST_DISCONNECTED = 0, ST_CONNECTED };

static volatile int s_edge_pending;          /* ISR 只設旗標 */
static enum link_state s_state = ST_DISCONNECTED;
static int      s_last_level;
static uint32_t s_stable_ticks;

/* ISR：只記「有邊緣」，不做判斷、不拉 HPD、不碰 link */
void SrcDet_ISR(int port)
{
    (void)port;
    s_edge_pending = 1;
}

/* 每 1 ms 由 task loop 呼叫：非阻塞的連續取樣 debounce */
void srcdet_task_1ms(int port)
{
    int level = Scaler_Read_SrcDet_Pin(port);

    if (s_edge_pending || level != s_last_level) {
        s_edge_pending = 0;
        s_last_level = level;
        s_stable_ticks = 0;                   /* 有變化就重新計時，毛刺自然被吃掉 */
        return;
    }
    if (s_stable_ticks < SRCDET_STABLE_TICKS) {
        s_stable_ticks++;
        return;
    }
    if (level && s_state == ST_DISCONNECTED) {
        aux_dpcd_edid_prepare(port);          /* 先讓 AUX／DPCD／EDID 就緒 */
        Scaler_Set_HPD(port, 1);              /* HPD 最後才拉高；link training 由 source 之後發起 */
        s_state = ST_CONNECTED;
    } else if (!level && s_state == ST_CONNECTED) {
        Scaler_Set_HPD(port, 0);
        link_teardown(port);
        s_state = ST_DISCONNECTED;
    }
}

/* sink 有事要通知 source：先寫 IRQ vector，再發 IRQ_HPD 短脈衝 */
int hpd_send_irq(int port, uint8_t vector_bits)
{
    if (s_state != ST_CONNECTED)
        return -1;                            /* HPD 低時不能發 IRQ_HPD */
    dpcd_set_irq_vector(port, vector_bits);   /* source 收到 IRQ_HPD 後會讀 0x201 */
    Scaler_Set_HPD(port, 0);
    udelay(HPD_IRQ_LOW_US);                   /* 實務上建議用硬體 timer 產生，避免中斷拉長脈寬 */
    Scaler_Set_HPD(port, 1);
    return 0;
}

/* EDID 等內容變了，要 source 重新偵測：拉低超過 2 ms */
extern void mdelay(uint32_t ms);
void hpd_request_replug(int port)
{
    if (s_state != ST_CONNECTED)
        return;
    Scaler_Set_HPD(port, 0);
    mdelay(HPD_REPLUG_LOW_MS);
    Scaler_Set_HPD(port, 1);
}
```

### 四、順序與 polling 備援

第三個坑是順序。source 看到 HPD 拉高（並 debounce 完）就會去讀 EDID／DPCD。如果 FW 在 AUX 還沒從省電狀態醒來時就拉高 HPD，source 的 AUX 交易會逾時或收到 DEFER，結果就是黑屏。kernel 的 `drm_dp_link_power_up()` 在寫 `DP_SET_POWER` 到 D0 之後 `usleep_range(1000, 2000)`，註解引述 DP 1.1 規格「Sink Device must exit the power saving state within 1 ms」。FW 該學的是把 HPD 拉高放到最後一個動作。

另外，kernel 文件明講「connector 可以同時被 polling，也從 hotplug handler 被 probe，以防 hotplug interrupt 不可靠」。這是 source 端的設計；對 sink FW 來說，意思是 HPD 狀態要穩定、可重複，不要依賴 source 一定抓得到每一個邊緣。

已查證與示意的界線：IRQ_HPD 0.5–1.0 ms、0.25 ms 以下可忽略、拔插事件大於 2 ms、source 100 ms 連接 debounce（DP 2.0 頁碼如上）；`DRM_CONNECTOR_POLL_HPD` 的行為、connector 可同時 polling 與 probe、`wait_hpd_asserted` 的 debounce 語意、D0 後等 1–2 ms、DPCD 0x201 讀寫、AUX native 交易重試 32 次、DP 沒有獨立 SCL/SDA 而 DDC 走 I2C-over-AUX，這些都有公開來源。所有 `Scaler_*` 介面、source detect 腳位、20 ms 穩定時間與自訂函式都是示意。本程式碼沒有直接對 DDC/CI 0x37 下命令；0x201 是 DP AUX 暫存器，不是 DDC/CI 的 VCP code。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 4K144 多輸入機種在 DVT 階段做插拔與睡眠喚醒壓力測試，三症狀一起爆：

第一個是客訴。使用者碰一下線材或旁邊的 USB hub，畫面偶爾黑一下再回來，裝置管理員的監視器項目跟著重新列舉。用示波器看 source detect 輸入，插拔瞬間有一串 100–300 µs 的毛刺。FW 的 ISR 看到任何邊緣就把 HPD 拉低走斷線流程，毛刺被當成 disconnect，source 看到的是一次真正的拔插。

第二個是認證預測試 fail。DP 相容性實驗室抓到 sink 發出的「事件通知」脈衝寬度不對：FW 用一個固定 5 ms 的低脈衝當通知，source 依規格把超過 2 ms 的脈衝當成拔線，MST 事件通知全部變成重新列舉。

第三個是客退前兆。S3 resume 後約一成機率黑屏，AUX 讀 DPCD 全部逾時。FW 日誌顯示 HPD 已經拉高，但那時候 AUX 還沒醒。

三個症狀共用一根：FW 把 HPD 當成普通 GPIO，沒當成一個有語意、要和 source detect debounce、要跟 AUX／DPCD／EDID 就緒順序對齊的狀態機。修正後 ISR 只設旗標、debounce 改連續取樣、事件通知改 0.5–1.0 ms 的 IRQ_HPD、HPD 拉高挪到最後，三個症狀一起消失。

## 新人避坑指南

1. 先分清楚方向：HPD 是 sink 輸出、source 偵測。sink 要 debounce 的是 source detect 輸入。
2. ISR 裡不准拉 HPD、不准改 link 狀態、不准碰 EDID RAM。ISR 只設旗標，其餘交給 task loop。
3. debounce 不要用單一固定 delay。每個 tick 取樣，連續穩定才算數，有變化就重新計時。
4. 脈寬照規格：IRQ_HPD 0.5–1.0 ms，拔插事件大於 2 ms（DP 2.0 PDF p.65、p.717）。IRQ_HPD 建議用硬體 timer 產生，避免被中斷拉長變成拔插。
5. HPD 拉高是最後一個動作：AUX 醒來、DPCD 與 EDID 備妥之後才拉高；link training 交給 source 發起。
6. 發 IRQ_HPD 前先寫好 DPCD 0x201（MST 則寫 ESI），source 收到才知道要看什麼。
7. 插拔瞬間把 AUX、HPD、Type-C CC/VCONN 一起納入狀態機 reset。DP 沒有獨立 SCL/SDA，DDC 走 I2C-over-AUX，只 debounce 單一輸入會留下競態。
8. 壓力測試要統計：線材晃動、USB hub 插拔、S3 resume 各跑 100 次以上，看有沒有誤發拔插或漏掉 IRQ_HPD。認證前用 AUX analyzer 確認 IRQ_HPD 有觸發 source 讀 DPCD。

## 思考題

如果今天 source 對 sink 發的 IRQ_HPD 「完全不理」，你要怎麼用示波器與 AUX analyzer 區分是「FW 沒發出正確的短脈衝」還是「source 收到了但沒處理」？提示：想想 DPCD 0x201 的 IRQ vector 有沒有被 source 讀走，以及脈寬落在 0.5–1.0 ms 之內嗎。

<details>
<summary>參考思路</summary>

在 sink 端 IRQ_HPD 發出前後，用 AUX analyzer 監看 source 有沒有對 DPCD 0x201（DEVICE_SERVICE_IRQ_VECTOR）發 AUX read。有讀代表 source 收到了 IRQ_HPD，問題在 source 端處理；沒讀代表脈衝可能不合格。用示波器量實際脈寬：短於 0.25 ms 可能被忽略，超過 2 ms 會被當成拔插（DP 2.0 PDF p.65、p.717）。

</details>

## 參考資料

1. Linux kernel 官方文件「Mode Setting Helper Functions」（Output Probing Helper、Display Port Helper、Display Port MST Helpers 章節，官方）：https://docs.kernel.org/gpu/drm-kms-helpers.html
2. Linux kernel `drivers/gpu/drm/display/drm_dp_helper.c`（`drm_dp_link_power_up` 的 D0 後 1–2 ms、`drm_dp_dpcd_access` 32 次重試、DPCD 0x201 讀寫，GPL-2.0 公開原始碼，官方）：https://raw.githubusercontent.com/torvalds/linux/master/drivers/gpu/drm/display/drm_dp_helper.c
3. ddcutil 官方文件「DDC and DisplayPort」（DP 無獨立 SCL/SDA、DDC 走 I2C-over-AUX，官方）：https://www.ddcutil.com/displayport/
4. VESA DisplayPort 官方 FAQ（DP 2.1b 概況、LTTPR／AdaptiveSync／Panel Replay 認證門檻，官方）：https://www.displayport.org/faq/
5. VESA DisplayPort Standard Version 2.0（VESA 會員文件，本文只引用頁碼）：HPD 與 IRQ_HPD 時序（PDF p.65、p.717、p.719）、source 端 HPD debounce（PDF p.381）、AUX 300 µs 回覆（PDF p.382）。2.1b 的差異待查證。
