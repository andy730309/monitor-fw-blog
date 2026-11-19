---
layout: post
title: "改了 EDID 螢幕卻沒變？checksum 錯位與 HPD toggle 的兩個 commit 陷阱"
date: 2026-11-10
tags: [EDID, HPD, checksum, DisplayPort, HDMI, 動態EDID]
level: intermediate
prerequisites: ["EDID 入門：用 edid-decode 解析顯示器身分證"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-10
description: "改了 EDID 螢幕卻沒變？動態重構 EDID 時要重算 checksum，並在資料落位後 toggle HPD，host 才會重新讀取。"
seo_title: "改了 EDID 卻沒變？checksum 與 HPD toggle"
difficulty: intermediate
---
> **重點摘要**：依輸入源動態重構 EDID 時有兩個陷阱：沒有重算 checksum，host 會直接丟掉這份 EDID；算好了卻沒有 toggle HPD，host 手上仍是舊資料。正確順序是先讓新資料落位，再拉低 HPD 通知 host 重新讀取。

支援多輸入源的顯示器，EDID 往往不是一份死資料：HDMI 模式掛 CTA-861 extension、DP 模式掛 DisplayID extension，韌體會依輸入源動態重構 EDID 陣列。這個設計很方便，也埋了兩顆地雷：重構時 checksum 沒重算，host 直接把你的螢幕當成不認識的東西；重算好了卻沒 toggle HPD，host 手上還是舊資料，你改了等於白改。這篇把這兩顆地雷一次拆掉。

## 前置知識

先把 EDID 想成一張「身分證＋規格表」。來源端（source，例如顯卡）接上顯示器後，會透過一條低速匯流排把這張表讀回去，才知道這台螢幕支援哪些解析度、更新率、HDR。

- **EDID 的長相**：Base Block 固定 128 bytes，開頭 8 bytes 是固定的 `00 FF FF FF FF FF FF 00`，像身分證的浮水印。byte 126 記錄「後面還有幾個 extension block」（extension flag），byte 127 是 checksum（E-EDID 規則，見參考資料 1、2）。
- **checksum 的規則**：每個 128-byte block 的最後一個 byte（byte 127），要讓「整個 block 128 bytes 的總和 mod 256 = 0」。注意，是整個 block 的總和，不是 checksum 自己的值。extension block（例如 CTA-861，tag 0x02）也各有自己的 byte 127 checksum。
- **EDID 走哪條路**：HDMI／DVI／VGA 用 DDC，就是 I2C，EDID 掛在 I2C 位址 0x50；DisplayPort 沒有 I2C 的 SCL/SDA 腳，DDC 是用輔助通道（AUX）上的 I2C-over-AUX 訊息模擬出來的[^1]。
- **HPD（Hot Plug Detect）**：一條中斷線。host 在 HPD 事件或定期 poll 時才會重新探測 connector、重讀 EDID。Linux kernel 的 `drm_helper_hpd_irq_event()` 就是對有設 HPD poll 旗標的 connector 跑一輪 detect cycle（kernel 官方文件，見參考資料 4）。

一個工程類比：EDID 像菜單，host 是客人。你改了菜單內容（韌體重構 EDID），但客人手上那本還是舊的——除非你把店門口的燈關掉再打開（HPD toggle），客人才會重新拿一本。

## 技術核心

### checksum 怎麼算才不會錯

Linux kernel 的 `edid_block_compute_checksum()`（`drivers/gpu/drm/drm_edid.c`，GPL-2.0 公開原始碼）把規則寫得最白：

```c
for (i = 0; i < EDID_LENGTH - 1; i++)
    csum += block[i];
crc = 0x100 - csum;   /* 讓 128 bytes 總和 mod 256 = 0 */
```

也就是 checksum = 0x100 −（block[0..126] 的總和）。動態 EDID 的死法有三種：

1. 改了 block 內容（換 DTD 的 pixel clock、換 SVD）但沒重算該 block 的 byte 127。
2. 只重算 Base Block，忘了每個 extension block 各自的 byte 127。
3. 增刪 extension 但 byte 126 的 extension flag 沒同步——host 會去讀不存在的 block，或漏讀該讀的。

### host 對 checksum fail 是「丟掉」不是「警告」

kernel 的 `edid_block_status_valid()`（同一份原始碼）有個很關鍵的分流：

- Base Block checksum fail → 整份 EDID 無效，driver 拿不到 mode list，只能靠 helper 補標準 VESA DMT mode（get_modes 回傳 0 時會自動補到 1024×768 為止的 DMT mode[^2]）。
- CTA extension（tag 0x02）checksum fail → kernel 容忍並照常採用，只用 pr_debug 印一行「…checksum is invalid, …, ignoring」，預設 log 等級下看不到。
- 其他 extension（例如 DisplayID，tag 0x70）checksum fail → 該 block 被判無效，裡面的資訊（例如 DisplayID 帶的 timing、VRR 範圍）在 Linux 端就不見了。

所以同一個 checksum bug，症狀可能是「解析度列表縮水」（Base Block 壞），也可能是「部分 timing 或 VRR 選項消失但基本顯示還活著」（DisplayID 等 extension 壞）；CTA extension 壞在 Linux 上反而可能完全沒症狀，問題一路藏到其他平台才爆。Windows 與 macOS 的 GPU driver 行為沒有公開文件（待查證），只能實測。

### HPD toggle：先落位，再關燈

host 只在 HPD 事件或 poll 時重讀 EDID。韌體端正確順序是：

1. 新 EDID 先寫進 shadow buffer 並完成驗證（header、逐 block checksum、extension flag）。
2. 驗證不過就不落位，保留舊 EDID。
3. 內容沒變就不 toggle HPD（比對 hash），否則使用者會看到無謂的黑畫面閃爍。
4. 落位後才 toggle HPD，迫使 host 走 detect cycle 重讀。

修正後的韌體骨架（示意架構，非任何真實晶片的 SDK）：

```c
#define EDID_BLOCK_SIZE      128   /* E-EDID：每個 block 固定 128 bytes（公開規格） */
#define EDID_EXT_FLAG_BYTE   126   /* byte 126 = extension flag（公開規格） */
#define EDID_CHECKSUM_BYTE   127   /* byte 127 = checksum（公開規格） */

/* HPD 控制為 scaler 內部暫存器／GPIO */
#define Scaler_Set_HPD(port, level)   /* 示意地址，非實際晶片規格 */
#define HPD_LOW_HOLD_MS  150          /* 示意值：DP 低於 2ms 會被當 IRQ_HPD（DP 2.0 PDF p.717–718）；
                                         HDMI 要求 EDID 變更時低電位至少 100ms（HDMI 1.4 PDF p.168）。
                                         實際值仍需 host 實測標定 */

static uint8_t edid_block_checksum(const uint8_t *block)
{
    uint8_t sum = 0;
    for (int i = 0; i < EDID_BLOCK_SIZE - 1; i++)
        sum += block[i];
    return (uint8_t)(0x100 - sum);   /* 與 kernel edid_block_compute_checksum 同式 */
}

static int edid_revalidate(uint8_t *edid, int n_blocks)
{
    static const uint8_t hdr[8] = {0x00,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x00};
    if (memcmp(edid, hdr, 8) != 0)
        return -1;

    edid[EDID_EXT_FLAG_BYTE] = (uint8_t)(n_blocks - 1);  /* extension flag 同步 */

    for (int b = 0; b < n_blocks; b++) {
        uint8_t *blk = edid + b * EDID_BLOCK_SIZE;
        blk[EDID_CHECKSUM_BYTE] = edid_block_checksum(blk);
        uint8_t total = 0;
        for (int i = 0; i < EDID_BLOCK_SIZE; i++)
            total += blk[i];
        if (total != 0)
            return -2;   /* 防禦性自驗 */
    }
    return 0;
}

int edid_commit(int port, const uint8_t *new_edid, int n_blocks)
{
    uint8_t *shadow = shadow_copy(new_edid, n_blocks);
    if (edid_revalidate(shadow, n_blocks) != 0)
        return -2;      /* 驗證不過就不落位 */

    /* 比對「重算過 checksum 的 shadow」，不是原始輸入 */
    if (edid_content_equal(port, shadow, n_blocks))
        return 1;       /* 沒變就不 toggle，避免黑畫面 */

    edid_swap_shadow(port);          /* 先落位：AUX/DDC 讀取路徑只 memcpy */
    Scaler_Set_HPD(port, 0);         /* 示意地址，非實際晶片規格 */
    /* 示意：不要用 mdelay 卡住主迴圈 150ms（DDC/CI、OSD、按鍵都會停）；
       改成排一個計時器，到時再拉高 HPD */
    hpd_timer_start(port, HPD_LOW_HOLD_MS);
    return 0;
}

/* 計時器到期時呼叫（示意） */
void hpd_timer_expired(int port)
{
    Scaler_Set_HPD(port, 1);         /* 示意地址，非實際晶片規格 */
}
```

已查證 vs 示意：block 結構、byte 126/127、checksum 演算法、header、I2C 位址 0x50、I2C-over-AUX 都是公開規格或公開原始碼可查；HPD 的 2ms／100ms 門檻已對照 DP 2.0 與 HDMI 1.4 規格頁碼；`Scaler_Set_HPD`、shadow swap、計時器、`HPD_LOW_HOLD_MS` 的實際值是示意，實際位址與數值要對你手上的 scaler SDK（多為 NDA 文件）。

### HPD toggle 本身也是協定行為

DP 的 HPD 有 long pulse（連接／斷開）與 short pulse（IRQ_HPD，事件通知）兩種語意。sink 產生的 IRQ_HPD 是 0.5–1.0 ms 的低脈衝；source 看到窄於 0.25 ms 的脈衝可忽略，寬於 2 ms 就當成拔除（unplug）處理[^3]。HDMI 則規定 sink 改了 E-EDID 內容時，要把 HPD 拉低至少 100 ms（HDMI 1.4 §8.5，PDF p.168；HDMI 2.1 PDF p.471 同義）。實務上（個人經驗推論）：低電位落在 2 ms 以內，host 會當成 IRQ_HPD 不重讀；toggle 太頻繁，host 走完整斷連流程，黑畫面閃爍還會被客戶當線材不良；toggle 時 EDID 還沒落位，host 讀到半新半舊，比不讀還慘。所以低電位時間做成 config 參數，用 AUX analyzer 實測各平台 host 標定，不要拍腦袋。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 4K144 多輸入機種（HDMI＋DP＋Type-C）在 DVT 階段支援動態 EDID：HDMI 模式掛 CTA-861 extension，DP 模式掛 DisplayID extension。測試炸出三個症狀：

1. **客訴（Claim）**：從 HDMI 切到 DP 後，Linux dmesg 出現 `EDID block 0 (tag 0x00) checksum is invalid`（訊息格式出自 kernel `drm_edid.c`），解析度列表縮水；Windows 端裝置管理員變成「一般隨插即用監視器」。
2. **認證預測試（Fail）**：DP 相容性實驗室的 EDID read test 抓到 extension flag（byte 126）與實際 extension 數量不一致。
3. **客退（Return）前兆**：OTA 更新修正了 EDID 內容，但使用者更新完行為沒變——host 根本沒重讀。

量測與協定層分析：用 AUX analyzer 抓 host 的 EDID 讀取，發現 host 在 HPD 沒動的情況下完全不會再發 I2C-over-AUX 的 EDID read；韌體 log 顯示 EDID 重構只重算了 Base Block 的 checksum，extension block 的 byte 127 是舊值。三個症狀共用兩根：checksum／extension flag 沒跟著重算，以及改完沒 toggle HPD。修正就是上面那個 `edid_commit()` 單一出口，三個症狀一次收斂。

## 新人避坑指南

1. **checksum 是整個 block 的總和**：改任何一個 byte 都要重算該 block 的 byte 127；Base Block 與每個 extension block 各算各的。
2. **byte 126 是 extension flag**：增刪 extension 必須同步，VESA 相容性測試會抓。
3. **commit 前自驗**：header 8 bytes、每 block 總和 mod 256 = 0、extension flag 一致；不過就保留舊 EDID，不要把壞資料落位。
4. **先落位再 toggle HPD**：順序反了，host 會讀到半新半舊。
5. **沒變就不要 toggle**：比對 hash，避免無謂黑畫面與 host 重新列舉 USB hub。
6. **HPD 時序做成參數**：DP 要大於 2 ms 才算 long pulse，HDMI 改 EDID 要至少 100 ms；預設值取兩者都滿足的值，再用 AUX analyzer／logic analyzer 對各平台 host 實測標定。
7. **CI 加 edid-decode 關卡**：每個 EDID 變體（HDMI/DP/Type-C 模式）都跑一次，checksum 與 extension flag 錯誤直接擋 build。
8. **OTA 動到 EDID 就強制重 commit**：不要假設 host 會自己重讀。

## 思考題

E-EDID 的 extension flag（byte 126）只有一個 byte，理論上最多標 255 個 extension，但 host 預設只會讀 Base Block 與第一個 extension block。請查 E-EDID／E-DDC 文件回答：host 要怎麼讀到更多 extension block？E-DDC 的 segment 定址機制是什麼？

<details>
<summary>提示</summary>
E-DDC 加入多位址能力，可定址多個 256-byte segment（最多 128 個，總計可達 32 KiB）；EDID 內也有 Block Map（tag 0xF0）機制列出所有 block。參考 Wikipedia EDID 條目與 E-EDID A2 原文。
</details>

## 參考資料

1. Wikipedia「Extended Display Identification Data」（非官方，引述 VESA E-EDID A2）：https://en.wikipedia.org/wiki/Extended_Display_Identification_Data
2. VESA E-EDID Standard Release A（EDID 1.4）PDF 鏡像（非官方鏡像）：https://glenwing.github.io/docs/VESA-EEDID-A2.pdf
3. Linux kernel `drivers/gpu/drm/drm_edid.c`（GitHub torvalds 鏡像，GPL-2.0 公開原始碼，checksum 演算法與 block 驗證行為）：https://raw.githubusercontent.com/torvalds/linux/master/drivers/gpu/drm/drm_edid.c
4. Linux kernel 官方文件「Mode Setting Helper Functions」（drm_helper_hpd_irq_event 與 get_modes fallback 行為，官方）：https://docs.kernel.org/gpu/drm-kms-helpers.html
5. Linux kernel `drivers/gpu/drm/display/drm_dp_helper.c`（I2C-over-AUX 註解，官方原始碼鏡像）：https://raw.githubusercontent.com/torvalds/linux/master/drivers/gpu/drm/display/drm_dp_helper.c
6. ddcutil 官方文件「DDC and DisplayPort」（I2C-over-AUX 與 DP++ 說明，官方）：https://www.ddcutil.com/displayport/
7. VESA DisplayPort 官方 FAQ（DP 2.1b 概況，官方）：https://www.displayport.org/faq/

8. VESA DisplayPort Standard Version 2.0（2019-06-26）：IRQ_HPD 0.5–1.0 ms、0.25 ms 以下可忽略、2 ms 以上視為拔除（PDF p.717–718）。會員文件，本文只引用頁碼並改寫。
9. HDMI Specification 1.4 §8.5 Hot Plug Detect：E-EDID 變更時 HPD 低電位至少 100 ms（PDF p.168）；HDMI 2.1 同義條文（PDF p.471）。Adopter 文件，本文只引用頁碼並改寫。

[^1]: ddcutil 官方文件「DDC and DisplayPort」，見參考資料 6。網頁文件，章節待查證。
[^2]: Linux kernel 官方文件「Mode Setting Helper Functions」，見參考資料 4。網頁文件，章節待查證。
[^3]: VESA DisplayPort Standard Version 2.0（2019-06-26），PDF p.717–718；另見 PDF p.65（見參考資料 8）。
