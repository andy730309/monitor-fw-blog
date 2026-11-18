---
layout: post
title: "DP AUX channel 時序錯誤與 EDID 解析錯位：從根因到韌體修正"
date: 2026-11-16
tags: [DP, AUX, EDID, DisplayID, HPD]
level: intermediate
prerequisites: ["基本的 DisplayPort 訊號連結理解", "EDID 結構與 CTA-861 extension 基礎"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-16
description: "DP AUX 時序錯誤會讓 EDID 讀取錯位、checksum 對不上。本文說明 AUX 交易格式、sink 端更新 EDID 的流程與韌體修正。"
difficulty: intermediate
---
> **重點摘要**：DP 的 AUX channel 承載 DPCD 讀寫與 I2C-over-AUX 的 EDID 讀取，sink 必須在時限內開始回覆。讀取時有位元錯誤或漏讀，EDID checksum 就會對不上。sink 端更新 EDID 時要依正確流程重算 checksum，並 toggle HPD 通知 source。

## 前置知識
DisplayPort 的 AUX channel 是一對半雙工的差動通道，使用 Manchester-II 編碼，UI 為 0.4–0.6 µs，約 1 Mbps（DP 2.0 Table 3-10，PDF p.723）。它承載 DPCD 暫存器讀寫、I2C-over-AUX（用來讀 EDID／DisplayID）以及 link training 相關的讀寫。HPD 是另一支獨立的訊號線，不走 AUX。

每一筆 AUX 交易的格式是：先送 10–16 個 pre-charge 的 0，再送 AUX_SYNC（16 個 0 加上 SYNC 結尾，含 pre-charge 共 26–32 個 0），接著是 4-bit 命令 COMM3:0、20-bit 位址、8-bit LEN、資料，最後是 STOP（DP 2.0 PDF p.721、p.382）。sink 必須在 300 µs 內開始回覆（PDF p.382）。若 sink 還沒準備好，可以回 AUX_DEFER；source 在 HPD 剛拉高或喚醒 sink 時，Reply Timeout 至少要設 3.2 ms（PDF p.382）。

EDID（Extended Display Identification Data）原本透過 DDC（I2C）讀取，DisplayPort 則用 I2C-over-AUX 搬運 EDID。EDID Base Block（Block 0）共 128 bytes，最後一個 byte（offset 127，0x7F）是 checksum，128 個 byte 加總後對 256 取餘數必須為 0。讀取時若有位元錯誤或漏讀，checksum 就會對不上。

## 技術核心
### AUX 時序：cycle-to-cycle jitter
DP 1.4 與 DP 2.0 都規定：同一筆交易內，相鄰 UI 的變化（cycle-to-cycle jitter）最大 0.08 UI，等於 48 ns（DP 2.0 Table 3-10，PDF p.723；DP 1.4 對應表格同值）。這裡的 UI 是 AUX 的 UI（約 0.5 µs），和 main link 的 1.62／5.4 Gbps 無關。

假設量到相鄰兩個 UI 分別是 518 ns 與 482 ns，差 36 ns，仍在 48 ns 以內。DP 1.1a 是否有更嚴的 0.04 UI 限制，本文沒有核對到原文（待查證）；不要用 main link 速率去換算 AUX 的 UI。

### sink 端更新 EDID 的正確流程
sink 不會自己發 AUX 交易；AUX 由 source（GPU）發起。sink 韌體要做的是：
1. 在本地 EDID buffer 改好資料。
2. 重新計算每個被改到的 block 的 checksum（offset 127）。
3. 產生 HPD 拔插事件，讓 source 重新讀 EDID。

HPD 的時序有規格可查：
- IRQ_HPD（短脈衝）：拉低 0.5–1.0 ms；短於 0.25 ms，source 可以忽略（DP 2.0 PDF p.717）。IRQ_HPD 是用來通知 source 讀 DPCD 狀態，不是讓 source 重讀 EDID。
- 拔插事件：拉低超過 2 ms，source 會當成 unplug／replug（PDF p.65、p.719）。典型做法是拉低大於 2 ms、小於 100 ms，避開 source 端 100 ms 的 debounce（PDF p.381）。

韌體修正示意碼：
```c
#include <stdint.h>

/* 示意介面，非實際晶片規格 */
#define EDID_BLOCK_SIZE   128U
#define HPD_REPLUG_LOW_MS 10U     /* 設計值：> 2 ms 且 < 100 ms（DP 2.0 PDF p.65、p.381） */

extern uint8_t g_edid_buf[];      /* sink 本地 EDID buffer，source 經 I2C-over-AUX 讀取 */
extern void set_hpd_pin(int level);
extern void mdelay(uint32_t ms);
extern void edid_buf_lock(void);  /* 更新期間對 source 回 I2C_DEFER 或擋讀取，示意 */
extern void edid_buf_unlock(void);

static void edid_fix_checksum(uint8_t *blk)
{
    uint8_t sum = 0;
    for (uint32_t i = 0; i < EDID_BLOCK_SIZE - 1U; i++) {
        sum = (uint8_t)(sum + blk[i]);
    }
    blk[EDID_BLOCK_SIZE - 1U] = (uint8_t)(0x100U - sum);  /* 128 bytes 加總為 0 */
}

void edid_commit_with_hpd_replug(const uint8_t *new_edid, uint32_t n_blocks)
{
    set_hpd_pin(0);                          /* 先拉低，source 不會讀到寫一半的 EDID */
    edid_buf_lock();
    for (uint32_t b = 0; b < n_blocks; b++) {
        uint8_t *blk = &g_edid_buf[b * EDID_BLOCK_SIZE];
        for (uint32_t i = 0; i < EDID_BLOCK_SIZE; i++) {
            blk[i] = new_edid[b * EDID_BLOCK_SIZE + i];
        }
        edid_fix_checksum(blk);
    }
    edid_buf_unlock();
    mdelay(HPD_REPLUG_LOW_MS);               /* 低電位 > 2 ms：source 視為拔插 */
    set_hpd_pin(1);                          /* 最後一定回到高電位 */
}
```

### EDID checksum 錯位與 HPD toggle 缺失
許多韌體實作在 EDID 更新後，沒有產生 HPD 拔插事件，host（GPU）端沒偵測到變化，就不會重新讀取 EDID。更糟的是，EDID block 的 checksum（offset 127）在資料變更後沒有重新計算，host 讀到錯誤的 checksum，驅動程式驗證失敗或用錯顯示參數。

正確的流程應為：[HPD 拉低] → [更新 EDID buffer] → [重算 checksum] → [單一出口] → [HPD 拉高]。

## 真實血淚案例
> 情境模擬（依公開規格推演），非真實客戶或產品事件。以下時間數值是示意。
>
> 於組裝線測試中，某批次 4K60 Hz 面板在開機後顯示「無訊號」或「偵測到不支援的訊號格式」。用邏輯分析器監看 AUX channel，發現 HPD 拉高後 source 很快就發起 I2C-over-AUX EDID 讀取，而 sink 的 EDID buffer 還在初始化，回覆內容不完整。修法是 sink 在 EDID 與 DPCD 準備好之前不要拉高 HPD；必要時對 I2C-over-AUX 回 I2C_DEFER（DP 2.0 Table 2-172，PDF p.380）。
>
> 另一個情境：韌體更新 EDID 中的色彩資料後，只送了很短的 HPD 脈衝，而且最後把 HPD 留在低電位。source 先是沒看到拔插事件，接著又以為螢幕被拔掉，畫面參數（色域、HDR capability）和實際面板不符。
>
> 修正方向：統一走「HPD 拉低 → 更新 EDID 並重算 checksum → 維持低電位大於 2 ms → HPD 拉高」，確保 host 讀到最新、正確的 EDID。

## 新人避坑指南
- 看懂 AUX 回覆碼：回覆碼在 AUX reply 的 COMM 欄位裡，不是 DPCD 暫存器。bits 1:0 是 Native 回覆（00 AUX_ACK、01 AUX_NACK、10 AUX_DEFER），bits 3:2 是 I2C-over-AUX 回覆，只有 Native 為 AUX_ACK 時才有效（DP 2.0 Table 2-172，PDF p.380）。
- HPD 脈衝寬度：IRQ_HPD 是 0.5–1.0 ms，短於 0.25 ms 可能被忽略；要 source 重讀 EDID，用大於 2 ms 的拔插事件（DP 2.0 PDF p.65、p.717）。
- 給 sink 準備時間：與其在每筆交易前加固定延遲，不如在 sink 還沒準備好時回 AUX_DEFER／I2C_DEFER，讓 source 依規格重試。
- 不要在 ISR 中處理整個 EDID 流程：sink 必須在 300 µs 內開始回覆（PDF p.382），ISR 只做必要的回覆與設 flag，其餘交給主迴圈。

## 思考題
> 在 DP 1.4 以後的系統中，若 EDID 讀取過程中收到 AUX_DEFER 回覆，正確的處理方式是什麼？請解釋 Defer 狀態下 sink 端的行為與 source 端的重試策略。

<details>
<summary>點此查看參考答案</summary>
AUX_DEFER 表示 sink 端目前還沒準備好處理這筆請求，source 可以稍後重試（DP 2.0 Table 2-172，PDF p.380）。規格要求 source 收到 AUX_DEFER 後至少重試七次才放棄（PDF p.410、p.414）；若完全沒收到回覆（Reply Timeout），至少重試三次（PDF p.236）。重試間隔規格沒有固定值，屬實作選擇。sink 端應該盡快把資料準備好，不要無限期回 DEFER。
</details>

## 參考資料
- VESA DisplayPort Standard Version 2.0（VESA 會員文件，本文只引用頁碼）：AUX 命令與回覆碼 Table 2-171／2-172（PDF p.379–380）、Reply Timeout（PDF p.382）、DEFER 重試（PDF p.410、p.414）、AUX 電氣與 jitter（PDF p.721–723）、HPD 與 IRQ_HPD（PDF p.65、p.381、p.717–719）。
- Coreboot ANX7625 EDID AUX retry mechanism — https://review.coreboot.org/q/c2496bc62e6ce4ff7e54d0985b0167246bdeb7d8
- VESA DisplayID Standard v2.0/v2.1 — https://vesa.org/featured-articles/vesa-rolls-out-displayid-version-2-0-standard-to-optimize-plug-and-play-connectivity-for-leading-edge-displays/
- Linux kernel DDC/I2C API — https://kernel.org/doc/html/latest/driver-api/ddc.html
- Texas Instruments SDAA295 Debugging Methodology — https://www.ti.com/lit/an/sdaa295/sdaa295.pdf
