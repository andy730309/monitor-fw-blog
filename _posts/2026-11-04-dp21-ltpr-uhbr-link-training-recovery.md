---
layout: post
title: "DP 2.1 UHBR 連結訓練失敗？LTTPR 狀態機與頻率降級 fallback 三個坑"
date: 2026-11-04
tags: [DisplayPort, LTTPR, UHBR, Link Training, DPCD, VESA]
level: intermediate
prerequisites: ["DP link training 基本概念（CR/EQ）、DPCD AUX 讀寫、EDID/DisplayID 基礎"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-04
difficulty: intermediate
---
## 前置知識

DisplayPort（DP）是顯示器與主機之間的數位影像介面。在影像出來之前，來源端（source）與接收端（sink）必須先做「連結訓練」（link training），約定好訊號率與通道數，這就像兩邊先對好對謯機頻道才能說話。DP 2.1 引入了 UHBR（Ultra High Bit Rate）頻率，每條通道最高 20 Gbps，四條通道可達 80 Gbps，夠跑 4K 600Hz 或 8K 120Hz。為了在長纜線上維持訊號品質，DP 2.1 引入了 LTTPR（Link Training Tunable PHY Repeater，連結訓練可調整 PHY 中繼器），一種只處理 PHY 層、不處理加密的訊號中繼器，能在連結訓練時調整自己的輸出參數。

DP 2.1 用 128b/132b 編碼取代舊的 8b/10b，並強制 RS(198,194) FEC。UHBR 頻率下，LTTPR 必須以「非透明模式」運作，source 會逐顆訓練每顆 LTTPR，再訓練 sink。這些細節都在 VESA DP 規格裡，但規格全文需 VESA 會員或 NDA，公開簡報與文件只能看到部分，實作時請對照手上的 NDA 文件。

## 技術核心

### LTTPR 發現與非透明模式

DP source 會讀 DPCD F0000h–F0004h（示意地址，非實際晶片規格）來發現路徑中有幾顆 LTTPR，每顆的能力是什麼。如果 sink 韌體沒正確轉發這些資訊，source 會以為沒有 LTTPR，直接用透明模式跑 UHBR，結果 link training 失敗、影像黑畫面或降級到 4K60。

UHBR 頻率下，VESA 規格規定 LTTPR 必須用非透明模式。sink FW 需在發現 LTTPR 後，把非透明模式旗標設好，讓 source 知道要逐顆訓練 LTTPR，而不是直接訓練 sink。

### INTRAHOP_AUX_REPLY_INDICATION（DPCD 102h）

UHBR 連結訓練開始前，source 會先檢查 DPCD 102h（示意地址，非實際晶片規格）的 INTRAHOP_AUX_REPLY_INDICATION 旗標。如果這個旗標是 1，sink 需把它寫回 00h 清除；如果是 0，則不得寫。sink FW 若完全不檢查這個旗標，AUX 讀寫事務就會出錯，連結訓練在還沒開始就卡住了。

### 128b/132b 失敗回復：頻率降級優先於通道數降級

這是最容易踩的坑。DP 2.1 規定，128b/132b DP 的連結訓練失敗時，應該先降頻率（4 通道 UHBR20 → 4 通道 UHBR13.5 → 4 通道 UHBR10），而不是先減通道數（4 通道 → 2 通道 UHBR20）。很多 sink FW 錯誤地先嘗試 2 通道 UHBR20，source 會拒絕，結果連結訓練反覆失敗，最後乖乖降級到 HBR3，使用者明明買了 4K144 螢幕，卻只跑 4K60。

DP 2.1a 起允許相同 Link Config 重試最多 2 次（受 CDF 控制）。sink FW 只重試 1 次就放棄，也會導致還能恢復的連結被過早降級。

### 並行 LTTPR 連結訓練（CDS / Hop / Intra-Hop Aux）

DP 2.1 引入並行 LTTPR 連結訓練，棄用舊的 CR Done，新增 Clock and Data Switch（CDS）、Hop、Intra-Hop Aux。source 會同時訓練每個 Hop，而不是一顆顆序列訓練，讓連結訓練在 650ms 內完成，而非 3 秒以上。如果 sink FW 還在用 8b/10b 的 CR/EQ 流程，就會與 source 的 128b/132b 並行訓練不匹配，導致連結訓練超時。

下面是示意性 C 片段，展示 LTTPR 發現、INTRAHOP 檢查、頻率降級 fallback 與同 Link Config 重試。暫存器地址與 Macro 除標註「已查證」者外，皆為 `/* 示意地址，非實際晶片規格 */`，請對照手上的 scaler SDK 與 NDA 文件。

```c
/* 示意：LTTPR DPCD 位址範圍（VESA DP v2.0 §3.6，地址為示意） */
#define LTTPR_DPCD_DISCOVERY   0xF0000   /* 示意地址，非實際晶片規格 */
#define LTTPR_DPCD_COUNT_CAP   0xF0004   /* 示意地址，非實際晶片規格 */

/* 示意：INTRAHOP_AUX_REPLY_INDICATION（VESA Taipei Workshop Oct 2025，DP2.1x CTS） */
#define DPCD_INTRAHOP_AUX_REPLY 0x00102  /* 示意地址，非實際晶片規格 */

/* 示意：UHBR link rate 編碼（非晶片規格，僅供邏輯示意） */
#define UHBR_RATE_UHBR20   0x14
#define UHBR_RATE_UHBR135  0x0F
#define UHBR_RATE_UHBR10   0x0A

#define MAX_LTTPR_COUNT    8
#define LT_LINK_CONFIG_RETRY_MAX  2   /* DP 2.1a 起允許 1–2 次，受 CDF 控制 */

typedef struct {
    uint8_t  lttpr_count;
    bool     non_transparent_mode;
    uint8_t  current_link_rate;
    uint8_t  current_lane_count;
    uint8_t  link_config_retry;
    bool     intrahop_aux_reply;
} dp_link_ctx_t;

/* LTTPR 發現：讀 DPCD F0000h–F0004h（示意地址） */
static bool dp_lttpr_discovery(dp_link_ctx_t *ctx)
{
    uint8_t buf[5];
    bool ok = aux_read_burst(LTTPR_DPCD_DISCOVERY, buf, sizeof(buf));
    if (!ok) {
        ctx->lttpr_count = 0;
        ctx->non_transparent_mode = false;
        return true;
    }
    ctx->lttpr_count = buf[0] & 0x07;   /* 示意位定義 */
    if (ctx->lttpr_count > MAX_LTTPR_COUNT) {
        ctx->lttpr_count = MAX_LTTPR_COUNT;
    }
    /* UHBR 率下 LTTPR 必須非透明模式（VESA DP 2.1 規定） */
    if (ctx->current_link_rate >= 0x0A) {
        ctx->non_transparent_mode = true;
    }
    return true;
}

/* 檢查並清除 INTRAHOP_AUX_REPLY_INDICATION（DPCD 102h，示意地址） */
static bool dp_check_intrahop_aux_reply(dp_link_ctx_t *ctx)
{
    uint8_t val;
    bool ok = aux_read_byte(DPCD_INTRAHOP_AUX_REPLY, &val);
    if (!ok) return false;
    ctx->intrahop_aux_reply = (val & 0x01) ? true : false;
    if (ctx->intrahop_aux_reply) {
        ok = aux_write_byte(DPCD_INTRAHOP_AUX_REPLY, 0x00);
        if (!ok) return false;
    }
    return true;
}

/* 128b/132b UHBR fallback：頻率降級優先於通道數降級 */
static const struct { uint8_t rate; uint8_t lanes; } uhbr_fallback[] = {
    { 0x14, 4 },   /* UHBR20, 4 lanes */
    { 0x0F, 4 },   /* UHBR13.5, 4 lanes */
    { 0x0A, 4 },   /* UHBR10, 4 lanes */
    /* 不放 2-lane UHBR20，避免違反 DP 2.1 fallback 原則 */
};

bool dp_uhbr_link_training(dp_link_ctx_t *ctx)
{
    int retry = 0;
    bool lt_ok;

    if (!dp_lttpr_discovery(ctx)) return false;
    if (ctx->current_link_rate >= 0x0A) {
        if (!dp_check_intrahop_aux_reply(ctx)) return false;
    }

    while (retry <= LT_LINK_CONFIG_RETRY_MAX) {
        lt_ok = dp_run_link_training(ctx->current_link_rate, ctx->current_lane_count,
                                     ctx->non_transparent_mode);
        if (lt_ok) return true;
        retry++;
    }

    /* 同 Link Config 重試用盡，降頻率 fallback（不先減通道數） */
    for (int i = 0; i < (int)(sizeof(uhbr_fallback) / sizeof(uhbr_fallback[0])); i++) {
        if (uhbr_fallback[i].rate == ctx->current_link_rate &&
            uhbr_fallback[i].lanes == ctx->current_lane_count) {
            if (i + 1 < (int)(sizeof(uhbr_fallback) / sizeof(uhbr_fallback[0]))) {
                ctx->current_link_rate = uhbr_fallback[i + 1].rate;
                ctx->current_lane_count = uhbr_fallback[i + 1].lanes;
                ctx->link_config_retry = 0;
                return dp_uhbr_link_training(ctx);
            }
            break;
        }
    }
    return false;
}
```

Python 示意（測試台驗證用，DDC/CI EDID 位址 0x50 已查證；DPCD/AUX 地址為示意）：

```python
DPCD_LTTPR_DISCOVERY = 0xF0000          # 示意地址，非實際晶片規格
DPCD_INTRAHOP_AUX_REPLY = 0x00102       # 示意地址，非實際晶片規格
UHBR_FALLBACK = [
    (0x14, 4),   # UHBR20, 4 lanes
    (0x0F, 4),   # UHBR13.5, 4 lanes
    (0x0A, 4),   # UHBR10, 4 lanes
]

def lttpr_discovery():
    data = read_dpcd(DPCD_LTTPR_DISCOVERY, 5)   # 示意函數
    if data is None:
        return 0, False
    return data[0] & 0x07, (data[0] & 0x07) > 0

def check_intrahop_aux_reply():
    val = read_dpcd(DPCD_INTRAHOP_AUX_REPLY, 1)  # 示意函數
    if val is None: return False
    if val[0] & 0x01:
        return write_dpcd(DPCD_INTRAHOP_AUX_REPLY, 0x00)  # 示意函數
    return True

def dp_uhbr_link_training_recovery():
    count, non_transparent = lttpr_discovery()
    if non_transparent and not check_intrahop_aux_reply():
        return False
    for rate, lanes in UHBR_FALLBACK:
        if uhbr_link_training(rate, lanes, non_transparent):  # 示意函數
            return True
    return False
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠 27 吋 4K144 顯示器（DP 2.1 sink，內建 LTTPR 非透明模式支援）透過 USB4 塢站接上某 GPU 平台 A。開機後影像長時間黑畫面，最終降級到 4K60 甚至 1080p60，OSD 顯示「DisplayPort 2.1」卻實際跑 HBR3。韌體 log 顯示 DP 連結訓練在 EQ 階段反覆超時，AUX 讀寫 LTTPR 暫存器時收到 AUX_NACK，最後 source 放棄 UHBR 並降級。

量測現象：開機到影像出現超過 5 秒（正常應在 1–2 秒內），解析度不對，偶爾無訊號需要重拔線。協定層分析指出：sink FW 沒正確做 LTTPR 發現（讀 DPCD F0000h–F0004h，示意地址），source 認為路徑無 LTTPR，以透明模式訓練 UHBR，實際上須非透明模式；fallback 路徑錯誤為先減通道數，導致 2 通道 UHBR20 被 source 拒絕；INTRAHOP_AUX_REPLY_INDICATION（DPCD 102h，示意地址）未檢查，AUX 事務出錯。

修正後：sink FW 正確做 LTTPR 發現並強制非透明模式，fallback 改為頻率降級（4L UHBR20 → 4L UHBR13.5 → 4L UHBR10），同 Link Config 重試最多 2 次，並檢查 DPCD 102h 旗標。連結訓練時間從超時降到 650ms 內，4K144 穩定出圖。

## 新人避坑指南

1. **不要把 DPCD 地址當成真實晶片規格**：文中出現的 F0000h、102h 等地址來自公開簡報與規格節錄，具體位定義需對照 scaler SDK 與 NDA 文件。寫 code 時一律加 `/* 示意地址，非實際晶片規格 */` 註解，避免移植到新平台時直接複製造成當機。
2. **UHBR fallback 順序不能反**：先降頻率，再減通道數。反過來會讓 source 拒絕 2 通道 UHBR20，連結訓練失敗，使用者覺得螢幕「沒發揮效能」。
3. **同 Link Config 重試不要只做一次**：DP 2.1a 起允許重試最多 2 次，這幾次重試通常就能把還能恢復的連結救回來，避免不必要的降級客訴。
4. **INTRAHOP_AUX_REPLY_INDICATION 是 UHBR 的門檻**：連結訓練開始前先檢查 DPCD 102h（示意地址），為 1 則寫 00h 清除，為 0 則不動，否則 AUX 讀寫會亂。
5. **產線要測多種 LTTPR 路徑**：無 LTTPR、1 顆 LTTPR、多顆 LTTPR（透過塢站或長纜線），搭配 Unigraf 或 Quantum Data 訊號產生器，驗證連結訓練收斂時間與 fallback 行為，避免出廠後才發現開機慢。

## 思考題

DP 2.1 規格規定 128b/132b 連結訓練失敗時應「先降頻率、再減通道數」，那如果你的 sink 只支援 4 通道，降到 UHBR10 4 通道仍失敗，接下來該怎麼辦？是降到 2 通道 UHBR20，還是直接降級到 HBR3？請查 VESA DP 2.1 規格與 CTS 文件確認答案（答案不在此文給出，建議新人自行對照規格）。

<details>
<summary>提示（點擊展開）</summary>
VESA DP 2.1 規格對 128b/132b fallback 有明確的頻率優先規則，但當所有 UHBR link config 都失敗後，是否允許降回 8b/10b HBR3，需對照規格 §3.6.6 與 CTS 測項。這也是產線 HIL 測試要覆蓋的邊界條件。
</details>

## 參考資料

1. VESA 首頁（DisplayPort 介紹、UHBR20/80 Gbps、DP80/DP40 線材）：https://vesa.org/ （官方，行銷頁）
2. VESA Free Standards（DP 2.x 規格需會員/NDA；DDC/CI 1.1、DisplayID、EDID Extensions、MCCS 2.2a 等為免費下載）：https://vesa.org/vesa-standards/ （官方）
3. DisplayPort.org（DP 2.1 UHBR20 80 Gbps、MST 預設開啟、DP80/DP40 線材）：https://www.displayport.org/ （官方）
4. VESA SF Workshop May 2025（DP 1.4x vs DP 2.x 對比表：UHBR 率、LTTPR 非透明模式強制、128b/132b fallback 頻率優先、同 Link Config 重試最多 2 次）：https://vesa.org/wp-content/uploads/2025/06/VESA-SF-Workshop_May-2025.pdf （官方簡報）
5. VESA DisplayPort (DP) Standard v2.0（§3.6 LTTPRs，p.875–909；需 NDA 全文，此處為第三方鏡像）：https://file-host.wiki-power.com/circuit-design/.../VESA%20DisplayPort%20(DP)%20Standard%20version%202.0.pdf （VESA 規格，非官方直連）
6. Unigraf「Brief Introduction to DisplayPort LTTPRs」（LTTPR 功能、DPCD F0000h–F028Fh 範圍、LTTPR Recognition 與 Link Training 階段）：https://www.unigraf.fi/app/uploads/2020/02/Introduction-to-Link-Training-Tunable-PHY-Repeaters-LTTPR.pdf （測試儀器廠，非官方規格）
7. Cadence 社群部落格「DisplayPort 128b/132b Concurrent LTTPR Link Training - Verification」（並行 LTTPR LT、CDS/Hop/Intra-Hop Aux、650ms LT 目標）：https://community.cadence.com/cadence_blogs_8/b/fv/posts/displayport-128b-132b-concurrent-lttpr-link-training （EDA 廠技術部落格，非官方規格）
8. VESA Taipei Workshop Oct 2025（DP2.1x CTS：INTRAHOP_AUX_REPLY_INDICATION DPCD 102h、Same Link Config retry、LTTPR Device Tests）：https://vesa.org/wp-content/uploads/2025/10/VESA-Taipei-Workshop_Oct-2025.pdf （官方簡報）

> 誠信聲明：本文情境為「情境模擬（依公開規格推演）」，非真實客戶、真實產品或真實客訴事件。暫存器地址與 Macro 除標註「已查證」者外皆為示意，非 RTD/Novatek/MStar 等具名晶片真實規格。DP 2.x 規格全文需 VESA 會員或 NDA，請讀者對照手上的 NDA 文件。數字與協定行為已盡量追蹤來源，未能查證者標示「待查證」。
