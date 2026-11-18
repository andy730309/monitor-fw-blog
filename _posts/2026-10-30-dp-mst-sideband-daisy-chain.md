---
layout: post
title: "daisy-chain 第二台螢幕忽然不見？DP sideband message 的 16-byte 分段與通知時序"
date: 2026-10-30
tags: [DisplayPort, MST, daisy-chain, sideband message, AUX, DPCD, HPD, interop]
level: intermediate
prerequisites: ["DPCD 入門：DisplayPort 設定資料結構與 Sink Capability 宣告", "DisplayPort link training 基礎"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: senior
sources_checked: 2026-10-30
difficulty: intermediate
---
# BLOG 標題：daisy-chain 第二台螢幕忽然不見？DP sideband message 的 16-byte 分段與通知時序

## 【前置知識準備】

先把 daisy-chain 講成人話。**daisy-chain（菊花鏈）** 就是一條 DP 線從電腦進螢幕 A，再從螢幕 A 的 DP OUT 出去接螢幕 B。聽起來像延長線，其實不是：電腦送出的其實是「多串流」，螢幕 A 內部要扮一個 **branch device（分支設備）**，決定哪個畫面給自己、哪個畫面往下轉。這套機制叫 **MST（Multi-Stream Transport）**，VESA 官方 FAQ 就把 MST 說成 DisplayPort 獨有的多螢幕能力。

用大樓來類比：main link（主連結）是貨梯，搬的是影像；**AUX channel** 是總機的對講線，慢很多，搬的是設定與控制；**sideband message（邊帶訊息）** 就是總機轉交的紙條，電腦（source）問「下面還有幾台」、「這條路能載多重」，螢幕內的總機（branch）回條。拓樸發現、分配頻寬、下游埠的 EDID 讀取，全走這條對講線。

這條對講線有三個尺寸限制，全部是新人最常忽略的部分：

1. **單次 AUX 讀寫大概只搬 16 bytes**（Linux kernel 的實作上限，`min(max_dpcd_transaction_bytes, 16)`）。就像一次只能抱一個小箱子。
2. **一張 sideband 便條最多 48 bytes**（Linux 的 `chunk[48]`、Xilinx 驅動的 `XDP_MAX_LENGTH_SBMSG 48`），超過要撕第二張，靠 header 的 somt（start of message transaction）與 eomt（end of message transaction）標示「這是第一張／這是最後一張」。
3. **訊息寫在哪是固定的**：source 寫請求到 DPCD `0x1000`（DOWN_REQ），branch 寫回覆到 `0x1400`（DOWN_REP）；反向 branch 主動通知用 `0x1600`（UP_REQ），source 回覆寫 `0x1200`（UP_REP）。位址在 Linux `drm_dp.h` 與 Xilinx `xdppsu_hw.h` 兩家獨立文件完全一致。

最後一個名詞：**IRQ HPD**。HPD（Hot Plug Detect）那條線除了「插了沒」，還會用短短一聲低脈衝當門鈴，提醒 source「留言板有新信」。AMD 的公開文件（PG199，引 VESA DP 1.2a）寫明：500 µs 到 1 ms 的脈衝算中斷請求，超過 2 ms 算拔線。門鈴按太短，會被按掉。

```
   PC (source)                     螢幕 A (branch)              螢幕 B (sink)
  ┌──────────┐   DP cable      ┌──────────────────┐  DP OUT   ┌──────────┐
  │ 拓樸管理  │◄══main link═══►│ 自己的畫面＋總機  │════════►│  第二台   │
  │          │◄─AUX(控制)────►│ sideband 收發     │          │          │
  └──────────┘                └──────────────────┘          └──────────┘
      寫 0x1000 請求 ──────►
      讀 0x1400 回覆 ◄──────  整筆寫完 → 置 0x2003 bit4 → HPD 門鈴(0.5–1ms)
```

## 【系統廠真實血淚案例】

情境模擬（依公開規格推演），非真實客戶或產品事件。

DVT 階段，一台 4K 機種要支援 daisy-chain，規格書寫「MST 多螢幕串接」，內建 GPU 平台 A 與平台 B 的冷開機驗證都過了。通路客訴進來：筆電休眠再喚醒，第二台黑畫面，桌面只剩一台；拔線重插就好。重現率約三成（示意），換台筆電有時候全好，第一輪回覆被寫成「請更新顯示卡驅動」，兩週後原封不動退回來。

先查 link training、查纜線，全是白工。掛上 AUX analyzer 抓 daisy-chain 連結，看到的現場是：source 寫了 `LINK_ADDRESS`（0x01，問拓樸），branch 的回覆其實有 45 bytes 左右（1 個輸入 port＋1 個輸出 port，依 Linux `drm_dp_sideband_parse_link_address()` 的結構推算：1 byte 的 reply/req type＋16 byte GUID＋1 byte port 數＋輸入 port 2 bytes＋輸出 port 20 bytes，加 body CRC 與 3 byte header），**至少要三個 16-byte AUX 交易才搬得完**，但 trace 上只看到第一段之後 `0x2003` 的 DOWN_REP_MSG_RDY 就被清掉，HPD 也只響了一聲。

**根因一（主）：先通知、後寫完。** branch 的 TX 流程把「置 MSG_RDY ＋打 IRQ HPD」塞進第一個 16-byte 分段的完成回呼。source 收到門鈴後，會照 header 裡的 msg_len 一口氣把 buffer 讀到底（Linux 先讀 16 bytes 取 header，再 `while (replylen > 0)` 讀滿），後面兩段還沒寫入，讀到舊資料，body CRC-4 對不上，整片丟棄。branch 卻以為通知過了，不再補第二聲。source 端於是等滿 **4 秒**（Linux `drm_dp_mst_wait_tx_reply()` 的 `msecs_to_jiffies(4000)`）才回 -EIO，拓樸根本建不起來，第二台自然不入列。

**根因二：還沒收齊就拆信。** source 寫 `0x1000` 時每一筆 AUX 交易都會觸發 branch 的 buffer-ready 中斷（AMD PG422 公開文件的流程寫得很清楚：讀到 buffer ready → **continue to collect** → 收到完整訊息才 process）。舊韌體收到第一段就解析 body，CRC 錯就回 NAK（reply type 0x01），變成重傳循環，運氣好第三段到齊才過，運氣不好一起撞進 4 秒超時。

**根因三：分配完沒簽收，第二台要等 3 秒。** `ALLOCATE_PAYLOAD`（0x11）之後，branch 要把 VC payload table（DPCD `0x800`–`0x8FF`，AMD PG299／PG300 公開文件載明範圍）更新完，再置 `DPCD 0x02C0` 的 bit0 與 bit1（PAYLOAD_TABLE_UPDATED、ACT HANDLED）。source 端等待上限是 **3 秒**（Linux `drm_dp_dpcd_poll_act_handled(..., 3000)`）。漏了這兩行的症狀就是「第二台黑畫面約 3 秒才跳出來」或「等不到直接掉線」。

**根因四（附帶）：門鈴按太短。** IRQ HPD 規格區間是 500 µs–1 ms，舊韌體取 0.5 ms 下緣；Linux kernel 的註解還記載某 Type-C→DP 轉接器會濾掉小於約 540 µs 的短脈衝。脈寬卡在死角，換台機器就「好」了，這就是最典型的 interop 假象。順帶一提：Linux 有 `poll_hpd_irq` 回呼的平台會自己補償（50 ms 週期 poll），只吃中斷的平台就硬扛 4 秒超時——同一份韌體在不同 source 上表現不同，這坑沒儀器挖不出來。

修正後的 TX 流程只剩一個順序，而且要封成單一函式：

```c
/* DPCD 位址已查證：Linux include/drm/display/drm_dp.h、Xilinx xdppsu_hw.h */
#define DPCD_SIDEBAND_DOWN_REP   0x1400u  /* branch → source 回覆 */
#define DPCD_IRQ_ESI0            0x2003u  /* bit4 DOWN_REP_MSG_RDY */
#define AUX_XFER_MAX             16u      /* Linux 實作上限；規格上限待查證 */

/* 示意地址，非實際晶片規格
 * Hpd_IrqPulse / Dpcd_SetBits / Aux_DpcdWrite 為示意 API；DPCD_SIDEBAND_DOWN_REP、
 * DPCD_IRQ_ESI0 為已查證之公開 DPCD 位址。 */
static int Sb_SendDownRep(const uint8_t *msg, uint16_t total)
{
    uint16_t off = 0;
    while (off < total) {                       /* 1. 整筆分段寫完，一段都不省 */
        uint16_t n = (uint16_t)((total - off) > AUX_XFER_MAX ? AUX_XFER_MAX : (total - off));
        if (Aux_DpcdWrite(DPCD_SIDEBAND_DOWN_REP + off, (uint8_t *)&msg[off], n) != (int)n)
            return -1;
        off = (uint16_t)(off + n);
    }
    Dpcd_SetBits(DPCD_IRQ_ESI0, (1u << 4));     /* 2. 才置「有新信」 */
    Hpd_IrqPulse(900);                          /* 3. 才按門鈴（0.5–1 ms，實測取值） */
    return 0;
}
```

RX 側是鏡像原則：收齊 msg_len、驗過 body CRC，才准 dispatch，未收齊不回 NAK；payload 分配成功路徑一定要補 `0x02C0` 的置位。修正後（模擬情境中）30 次 sleep/wake 壓測全數恢復，AUX trace 上 4 秒／3 秒兩條時間線都不再出現。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

- **DPCD `0x1400`（DOWN_REP）與 `0x1000`（DOWN_REQ）**：sideband 訊息的收發地址，AUX trace 直接對這兩個位址讀寫，第一順位看這裡。
- **DPCD `0x2003` bit4/bit5（`0x0201` 同位元的舊版位置）**：DOWN_REP_MSG_RDY／UP_REQ_MSG_RDY，「有新信」的貼紙。它被置位的時間點與 buffer 內容齊全的時間點是否一致，就是本 Bug 的分水嶺。
- **DPCD `0x02C0` bit0/bit1**：payload table 更新與 ACT handled 的簽收。第二台「等 3 秒才亮」一律先看它。
- **HPD 那條線**：量脈衝寬度，500 µs–1 ms 是中斷請求、>2 ms 是拔線（AMD PG199 引 VESA DP 1.2a）。示波器夾上去比看 log 快。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- **「寫完才通知、收齊才處置」寫進架構，不要靠 code review 記得。** 通知點封成單一函式，且只能在 buffer 完整後被呼叫；RX 那邊用狀態機（active／len／expect）擋住，未收齊連 NAK 都不准發。
- **timeout 分層**：source 端有 50 ms poll、4 秒 tx 總時限、3 秒 ACT poll 三個數字（皆出自 Linux 公開原始碼）。你的測試報告若出現「剛好 3 秒」「剛好 4 秒」，那就是撞到對手的 timeout，往這三個數字對，不要自己另猜一個 5 秒。
- **脈寬取區間偏長端並實測**：0.5–1 ms 的下半部是轉接器濾波的高風險區。留 margin 比省那幾百 µs 值錢。
- **壓測組合要含轉接器**：sleep/wake × 30、hot-plug × 30、輸入切換 × 30，並且至少兩個 GPU 平台（命名用平台 A/B）加一款 Type-C→DP 轉接器。interop bug 只在特定組合現形。
- **先問 source 支不支援 MST**：只支援 SST 的 dongle 搭 daisy-chain 本來就不會動。客訴第一輪先過濾這件事，別浪費一輪拆機。

### 3. 思考題

1. 如果 branch 的 `LINK_ADDRESS` 回覆有 3 個輸出 port，整筆訊息會超過單張 48 bytes 的便條，要拆兩片（header 的 somt=1／eomt=0 再接 somt=0／eomt=1）。請查 VESA DisplayPort Standard §2.11 與 Linux `drm_dp_mst_handle_down_rep()`：source 在 `have_eomt` 為 false 時為什麼「不清 reply buffer」？branch 又靠什麼知道要再發一次門鈴？（提示：看 `/* Multi-packet message transmission, don't clear the reply */` 這段註解，以及 `0x2003` 的 ack 流程。）
2. PBN（Payload Bandwidth Number）可以想成貨梯的載重預算。請查 VESA 文件的 payload bandwidth calculation 與 Linux `drm_dp_calc_pbn_mode()` 的註解：4K60 第二台與 4K144 第二台在同一條 HBR2×4 upstream link 上，什麼情況下必須開 DSC 才塞得下？（提示：PBN 單位與 lanes、link rate、bpp 的關係；available PBN 總表在規格裡。）
3. 為什麼「換一台電腦就好」不能當結案理由？請用本篇的三個時間常數（50 ms／3 秒／4 秒）解釋：poll 式與純中斷式 source 在同一個 bug 上會表現出什麼不同的症狀。

## 參考資料

1. Linux kernel — `include/drm/display/drm_dp.h`（sideband buffer 0x1000/0x1200/0x1400/0x1600、0x0201 bit4/bit5、0x02C0、MSTM_CAP 0x021／MSTM_CTRL 0x111、GUID 0x030、訊息型別 0x01/0x10/0x11/0x14/0x20–0x24、ACK/NAK）— 官方（開放原始碼 kernel 文件）：https://github.com/torvalds/linux/blob/master/include/drm/display/drm_dp.h
2. Linux kernel — `drivers/gpu/drm/display/drm_dp_mst_topology.c`（header CRC-4、16-byte AUX 分段讀寫、48-byte fragment、4 秒 tx timeout 與 50 ms poll、ACT 3 秒 poll、LINK_ADDRESS reply 解析、轉接器過濾 <~540 µs HPD 的註解）— 官方（開放原始碼 kernel 文件）：https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/display/drm_dp_mst_topology.c
3. Linux kernel — `include/drm/display/drm_dp_mst_helper.h`（sideband header 結構、chunk[48]、PBN 結構）— 官方（開放原始碼 kernel 文件）：https://github.com/torvalds/linux/blob/master/include/drm/display/drm_dp_mst_helper.h
4. AMD — PG422 DisplayPort RX Subsystem: MST AUX Messaging（DOWN_REQUEST_BUFFER 收完整訊息才 process、回覆寫 DOWN_REPLY_BUFFER）— 官方（晶片廠公開文件）：https://docs.amd.com/r/en-US/pg422-v-dp-rxss2/MST-AUX-Messaging
5. AMD — PG299 DisplayPort TX Subsystem: Enabling MST（PBN 分配 → 0x800 起寫 VC payload → 0x02C0 → 等 ACT Handled）— 官方（晶片廠公開文件）：https://docs.amd.com/r/en-US/pg299-v-dp-txss1/Enabling-MST
6. AMD — PG199 DisplayPort TX Subsystem: Hot Plug Detection（debounce >250 µs、500 µs–1 ms 中斷、>2 ms 離開，引 VESA DP 1.2a）— 官方（晶片廠公開文件）：https://docs.amd.com/r/en-US/pg199-displayport-tx-subsystem/Hot-Plug-Detection
7. Xilinx — Vitis `xdppsu_hw.h`（DPCD sideband buffers 0x01000–0x01600、ESI0 0x02003、HPD_DURATION 以 µs 為單位）— 官方（晶片廠公開文件）：https://xilinx.github.io/embeddedsw.github.io/dppsu/doc/html/api/xdppsu__hw_8h.html
8. VESA — DisplayPort 2.1 新聞稿（MST 為 DisplayPort 獨有能力）— 官方（VESA）：https://vesa.org/featured-articles/vesa-releases-displayport-2-1-specification/
9. DisplayPort 官方 FAQ（VESA）（DP 2.1b 認證最低需求、compliance program、MST 定位）— 官方（VESA）：https://www.displayport.org/faq/

提醒：sideband message 完整定義（§2.11）、PBN／available bandwidth 表、ACT trigger 細節都在 VESA DisplayPort Standard 會員文件裡；本文只依公開來源撰寫，開發時請對照手上 NDA 文件。AMD 的三份文件頁面需 JavaScript，本篇依搜尋引擎引用的原文片段核對，完整內容待開啟瀏覽器複核（待查證）。文中程式碼的 chip-specific API 與函式名皆為示意（示意地址，非實際晶片規格），DPCD 位址則為已查證的公開定義。
