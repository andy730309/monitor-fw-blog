---
layout: post
title: "OSD 偶爾卡半秒、久掛又冒黑塊？顯示器韌體的 ISR 與 task 分工三個坑"
date: 2026-11-04
tags: [RTOS, ISR, OSD, memory, watchdog, DDC-CI]
level: intermediate
prerequisites: ["C 語言與嵌入式基礎（volatile、中斷）", "OSD menu 基本架構", "DDC/CI 與 MCCS 入門"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "OSD 偶爾卡半秒、久了冒黑塊？說明顯示器韌體的 ISR 與 task 分工、優先權方向、記憶體配置與 watchdog 設計。"
seo_title: "OSD 卡頓與黑塊：ISR 與 task 分工三個坑"
difficulty: intermediate
---
> **重點摘要**：ISR 的鐵律是記錄事件、清中斷、通知 task，其他事情一律交給 task。影像、OSD 與 DDC/CI 的即時性需求不同，混在同一個 super-loop 裡就會不穩。記憶體要盡量靜態配置，DDC/CI 的等待不能卡住主迴圈，watchdog 要監看每個 task。

## 前置知識

想像一間小吃店。外場櫃檯只有一個人，客人一來就要立刻收單，收完單馬上交給內場。櫃檯不能停下來切菜，因為一停，後面的客人就全部堵在門口。內場可以排隊、可以同時處理好幾張單，但櫃檯的原則是「只收件，不煮菜」。

Monitor 韌體裡的中斷服務常式（Interrupt Service Routine，ISR）就是那個櫃檯。按鍵、DDC/CI 匯流排、VSYNC 這些事件隨時會來，硬體會打斷目前的工作去執行 ISR。ISR 一旦開始跑，所有 task 都得等它結束；優先權比它低的中斷也只能排隊。所以 ISR 的鐵律是：記錄發生什麼事、把中斷清掉、通知後面的 task，其他事情一律交給 task。

Task 則是內場。它有自己的堆疊與優先權，可以被排程器切換，也可以合法地阻塞等待。影像路徑的 task 要求每張影格準時，OSD 與按鍵的 task 要求反應夠快，DDC/CI 的 task 則是背景工作。把這三種即時性混在同一個 super-loop 裡，就會出現「明明每個功能都寫對了，湊在一起卻不穩」的現象。

還有一個容易被忽略的角色：記憶體。靜態配置（static allocation）像店裡事先隔好的固定座位，數量固定、位置固定，不會臨時找不到位子；動態配置（`malloc`／`free`）像把桌椅搬來搬去，短期很方便，長期會留下零碎空間。靜態配置更具確定性、移除配置失敗的處理需求、也移除 heap 碎片化的風險；代價是必須在編譯期把記憶體規劃清楚[^1]。

## 技術核心

### ISR 只做三件事

FreeRTOS Kernel Book 第 7 章對 ISR 的建議很直接：ISR 應該記錄中斷原因、清除中斷，其餘處理 deferred 到 task。理由不是「風格問題」，而是硬體現實：task 只有在沒有 ISR 執行時才能跑；ISR 會對 task 的開始時間與執行時間加入 jitter；部分架構在 ISR 期間不接受新中斷；而且 task 與 ISR 共用資源時還要另外保護（參考資料 1，7.3）。

同一章也明訂兩條會直接當機的規則。第一，非 `FromISR` 版本的 API 不可在 ISR 呼叫，因為它可能會把「呼叫它的 task」放進 Blocked 狀態，但 ISR 裡根本沒有這個 task。第二，中斷安全 API 需要搭配 `pxHigherPriorityTaskWoken` 與 `portYIELD_FROM_ISR()`，才能在離開 ISR 時切換到被喚醒的高優先權 task（參考資料 1，7.2.4、7.2.5）。

以 DDC/CI 為例，錯誤寫法是在 I2C 從機中斷裡直接組封包、判斷 VCP code、甚至更新 OSD。封包長度不固定，ISR 執行時間就不固定；按鍵與 VSYNC 只能等。正確寫法是 ISR 只把 FIFO 抽乾、放進 ring buffer、清中斷、通知 worker task。解析、VCP 處理、OSD 狀態更新都在 task 裡做。

```c
/* ISR 骨架：只取資料、清中斷、通知 task
 * 已查證：FreeRTOS API 名稱與使用規則（Kernel Book ch07）。
 * 示意：scaler 暫存器位址、IRQ 名稱、FIFO 深度。
 */

/* 示意地址，非實際晶片規格 */
#define REG_DDC_RX_FIFO      0x3100
#define REG_DDC_RX_COUNT     0x3104
#define REG_DDC_IRQ_CLEAR    0x310C

void DDC_IRQHandler(void)                 /* IRQ 名稱示意 */
{
    BaseType_t woken = pdFALSE;
    uint8_t    byte;

    while (scaler_read32(REG_DDC_RX_COUNT) > 0U) {
        byte = (uint8_t)scaler_read32(REG_DDC_RX_FIFO);
        (void)ring_put_from_isr(&g_ddc_ring, byte);   /* 滿了就記 overflow */
    }
    scaler_write32(REG_DDC_IRQ_CLEAR, 1U);

    vTaskNotifyGiveFromISR(g_ddc_task, &woken);
    portYIELD_FROM_ISR(woken);
}
```

### 優先權的數字方向，很多人記反

Arm 官方 Cortex-M3 文件寫得很清楚：NVIC 的可程式優先權是 0–255，數值越大代表優先權越低，0 是最高；外部中斷的優先權暫存器位於 `0xE000E400`–`0xE000E4EF`（NVIC_IPR0–IPR59）（參考資料 4）。

FreeRTOS 的規則則是：會呼叫 `FromISR` API 的中斷，其硬體優先權數值不得小於 `configMAX_SYSCALL_INTERRUPT_PRIORITY`。翻成白話：這種中斷必須「比核心臨界區允許的層級更低」，核心才有辦法在臨界區內暫時遮住它。如果你的 DDC/CI IRQ 設成 0，卻在裡面呼叫 `xSemaphoreGiveFromISR()`，等於在核心保護不到的地方動佇列內部狀態。這種 bug 不會每次爆，而是幾十次才一次，log 通常只留下「最後一筆中斷」這種沒用的線索。

```c
/* 優先權設定骨架
 * 已查證：Arm 文件「數值越大優先權越低」與 FreeRTOS 的 FromISR 規則。
 * 示意：nvic_set_priority() 等 API 依 MCU/SDK 而異。
 */
#define DDC_IRQ_PRIORITY   (configMAX_SYSCALL_INTERRUPT_PRIORITY + 1U)

static void board_irq_init(void)
{
    nvic_set_priority(IRQ_DDC, DDC_IRQ_PRIORITY);
    nvic_enable(IRQ_DDC);
}
```

實務上不要靠記憶維護這條規則。把「所有會呼叫 `FromISR` API 的 IRQ」列成清單，在 code review 與靜態檢查各擋一次；新增加一個中斷，就要重新檢查一次。

### 記憶體：能靜態就靜態，不能靜態就用固定 pool

FreeRTOS 提供五種 heap 範例。`heap_1` 只配置不釋放，完全確定性且不會碎片化；`heap_4` 用 first-fit 並合併相鄰 free block，適合反覆配置不同大小；`heap_5` 則能把多塊分離的 RAM 合成一個 heap（參考資料 2，3.2.1、3.2.4、3.2.5）。但對 monitor 的 OSD 來說，最穩的還是「開機時就把 buffer 準備好」。

理由很簡單：OSD 的頁面 buffer、字型暫存、動畫暫存大小是可預期的。既然可預期，就沒有理由在執行期 `malloc`。用固定 block pool，配置失敗時回傳 NULL，呼叫端走明確 fallback（例如降級成不開動畫、只畫單色底），而不是往 NULL 指標寫。這也呼應 FreeRTOS 文件對 `vApplicationMallocFailedHook()` 的提醒：正式產品應該優雅恢復，而不是把配置失敗當成致命錯誤（參考資料 2，3.3.6）。

```c
/* 固定 pool 骨架：開機後不再 malloc
 * 已查證：static allocation 可移除碎片化與配置失敗風險（Kernel Book ch03）。
 * 示意：block 數量與大小依產品 OSD 資源規劃。
 */
#define OSD_POOL_BLOCKS   8
#define OSD_BLOCK_BYTES   4096

static uint8_t  g_osd_pool[OSD_POOL_BLOCKS][OSD_BLOCK_BYTES];
static uint32_t g_osd_used_mask;

void *osd_block_alloc(void)
{
    for (uint32_t i = 0; i < OSD_POOL_BLOCKS; i++) {
        if ((g_osd_used_mask & (1UL << i)) == 0U) {
            g_osd_used_mask |= (1UL << i);
            return g_osd_pool[i];
        }
    }
    return NULL;                  /* 呼叫端必須處理 */
}

void osd_block_free(void *p)
{
    for (uint32_t i = 0; i < OSD_POOL_BLOCKS; i++) {
        if (p == g_osd_pool[i]) {
            g_osd_used_mask &= ~(1UL << i);
            return;
        }
    }
    fw_assert(0);                 /* 傳入非 pool 指標，當場抓 */
}
```

### DDC/CI 的等待不能卡住整條主迴圈

ddcutil 官方文件引述 DDC/CI 規範：主機送出命令後要等 40–200 ms 再讀回應，依 operation 而定；ddcutil 因此約九成時間都花在等待（參考資料 3；原始規範條文頁碼待查證）。Monitor 當接收端（sink）時雖然多數是被動回應，但韌體端若用「送一段、`delay_ms()`、再處理下一段」的寫法，這個等待會跟 OSD 重繪、按鍵掃描共用同一個迴圈。使用者按鍵的反應時間，就被協定等待綁死。

把 DDC/CI 寫成非阻塞狀態機：記錄下一個動作的 due tick，每輪只檢查「現在是否到期」。若用 RTOS，就放到獨立 task，用 blocking wait 讓出 CPU，而不是在共用迴圈裡 busy wait。

```c
/* 非阻塞 worker 骨架
 * 已查證：DDC/CI 40–200 ms 等待語意（ddcutil 官方文件）。
 * 示意：parser 與 ring buffer 為平台實作。
 */
static void ddc_task(void *arg)
{
    ddc_parser_t parser;
    uint8_t      byte;

    ddc_parser_init(&parser);
    for (;;) {
        /* 有通知就處理，沒有就讓出 CPU；20 ms 只是喚醒上限，不是協定等待 */
        (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));

        while (ring_get(&g_ddc_ring, &byte) == 0) {
            ddc_parser_feed(&parser, byte);          /* 純狀態機，不做 blocking I/O */
        }
        ddc_parser_tick(&parser, xTaskGetTickCount()); /* 到期才送下一段 */
        hb_kick(HB_DDC);
    }
}
```

### Watchdog 要看每個 task，不是只看主迴圈

把 watchdog feed 放在主迴圈，只能證明「主迴圈還有在跑」。如果 OSD task 卡在一個永遠不會來的旗標，主迴圈照樣餵狗，系統看起來活著，功能已經死了。比較可靠的做法是每個 task 定期更新自己的 heartbeat，watchdog task 檢查全部人的最後更新時間；逾時先安全關背光與輸出，再 reset，並把 reset reason 寫進 NVRAM。

```c
/* Heartbeat watchdog 骨架
 * 已查證：FreeRTOS task 與 tick API 名稱。
 * 示意：timeout 數值依 panel 保護時序與產品需求標定。
 */
typedef enum { HB_DDC = 0, HB_OSD, HB_VIDEO, HB_WDT, HB_COUNT } hb_id_t;
static volatile TickType_t g_hb_last[HB_COUNT];

void hb_kick(hb_id_t id)
{
    g_hb_last[id] = xTaskGetTickCount();
}

static void watchdog_task(void *arg)
{
    const TickType_t limit = pdMS_TO_TICKS(WDT_TASK_LIMIT_MS);

    for (;;) {
        TickType_t now = xTaskGetTickCount();
        for (int i = 0; i < HB_COUNT; i++) {
            if ((now - g_hb_last[i]) > limit) {
                system_safe_shutdown();   /* 先關背光與輸出，再 reset */
            }
        }
        hb_kick(HB_WDT);
        vTaskDelay(pdMS_TO_TICKS(WDT_CHECK_MS));
    }
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 ODM 的 4K 機種在 DVT 出現三個症狀。第一，連續快按 joystick 開關 OSD，OSD 偶爾停住約半秒，按鍵像被吃掉。第二，切換輸入來源時，約每數十次會遇到一次 watchdog reset，log 只留下最後一筆「DDC/CI RX」。第三，產線老化測試掛機數小時後，OSD 圖示出現黑塊或錯位，重開機就恢復。

三個症狀一開始被當成三個 bug：按鍵 debounce、電源順序、字型解壓縮。查了兩週沒有交集。後來把 ISR 執行時間與 heap 使用量一起拉出來，才看到共同根因。

第一個症狀的量測顯示，DDC/CI 中斷進來後，ISR 內同時做了封包重組與 OSD 狀態更新，執行時間隨封包內容變動。按鍵中斷只能排隊，這就是「按鍵被吃」的來源。第二個症狀的 log 時間點，剛好對應到 DDC/CI IRQ 與核心臨界區重疊；檢查設定才發現 DDC/CI IRQ 用了最高優先權 0，卻在裡面呼叫 `FromISR` API。第三個症狀則是 heap 碎片：每次開選單配置、關閉釋放，長時間後雖仍有 total free，但沒有夠大的連續 block，配置失敗又沒檢查，於是往 NULL 指標寫。

修正分三層。ISR 只保留抽 FIFO、清中斷、通知 task。DDC/CI IRQ 優先權改到核心可遮罩的層級，並把「所有 `FromISR` 中斷」列入 review 清單。OSD buffer 改成開機配置的固定 pool，配置失敗走降級路徑。watchdog 改成檢查每個 task 的 heartbeat，reset 前先關背光與輸出。三種症狀在下一輪 DVT 就沒有再出現。

## 新人避坑指南

第一，看到中斷就問一句：「這件事能不能延後？」能延後就延後。ISR 裡不要解析可變長度封包、不要寫 log、不要配置記憶體、不要更新 OSD。

第二，把優先權的數字方向貼在座位上。Arm 的規則是數值越大優先權越低，0 是最高（參考資料 4）。FreeRTOS 的規則是會呼叫 `FromISR` API 的中斷，數值不得小於 `configMAX_SYSCALL_INTERRUPT_PRIORITY`。這兩句話要一起記，單記一句一定有人設反。

第三，DDC/CI 的 40–200 ms 是「主機端」的等待語意（參考資料 3；原始規範條文頁碼待查證），不是叫你用 `delay_ms()` 去等。Monitor 韌體要做的是非阻塞狀態機：時間到才動作，時間沒到就讓出 CPU。

第四，OSD 資源能放 flash 就放 flash，能靜態就靜態。真的需要暫存，用固定 block pool，且每個配置點都要有失敗處理。`malloc` 回傳 NULL 不是「很少發生」，是「遲早發生」。

第五，watchdog 不是餵狗比賽。每個 task 都要有 heartbeat，watchdog 要檢查全部；reset 前先安全關背光與輸出，避免面板出現異常畫面。reset reason 與 heap high-water mark 要留下來，客退分析才有材料。

第六，量測要看 ISR 進入到離開的時間與 task jitter，不要只看 CPU load 百分比。用 GPIO toggle 或邏輯分析儀都行；沒有量測，就只是在猜。

## 思考題

假設你的 DDC/CI IRQ 優先權設為 3，`configMAX_SYSCALL_INTERRUPT_PRIORITY` 設為 5（數值越大優先權越低）。這個中斷可以呼叫 `xSemaphoreGiveFromISR()` 嗎？如果不行，應該改 IRQ 還是改核心設定？改動後對按鍵反應時間與 DDC/CI 吞吐量各有什麼影響？

<details>
<summary>提示</summary>
先確認「數值不得小於」的方向：3 比 5 小，代表優先權比核心允許的層級還高，不行。實務上通常改 IRQ 優先權，而不是放寬核心設定，因為放寬核心設定會讓更多中斷繞過臨界區保護。改完要重量按鍵 jitter 與 DDC/CI 重試率，兩者會互相拉扯。
</details>

## 參考資料

1. FreeRTOS Kernel Book, Chapter 7 Interrupt Management（官方文件）：https://github.com/FreeRTOS/FreeRTOS-Kernel-Book/blob/main/ch07.md
2. FreeRTOS Kernel Book, Chapter 3 Heap Memory Management（官方文件）：https://raw.githubusercontent.com/FreeRTOS/FreeRTOS-Kernel-Book/main/ch03.md
3. ddcutil Documentation, Performance and Tuning Options（官方文件；引述 DDC/CI 規範的 40–200 ms 等待；原始規範頁碼待查證）：https://www.ddcutil.com/performance_options/
4. Arm, Cortex-M3 Devices Generic User Guide, Nested Vectored Interrupt Controller（官方文件）：https://developer.arm.com/documentation/dui0552/latest/cortex-m3-peripherals/nested-vectored-interrupt-controller
5. Arm, Armv8-M Exception Model User Guide, Exception priority level definitions（官方文件）：https://support.arm.com/documentation/107706/0100/Exceptions-and-interrupts-overview/Exception-priority-level-definitions

[^1]: FreeRTOS Kernel Book, Chapter 3 Heap Memory Management，§3.1.3（官方，見參考資料 2）。網頁文件，無 PDF 頁碼。
