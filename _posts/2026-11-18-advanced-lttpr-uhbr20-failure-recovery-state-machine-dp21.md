---
layout: post
title: "UHBR20 一過中繼器就訓練失敗？LTTPR one-hot 計數、模式切換序列與 fallback 階梯的三個坑"
date: 2026-11-18
tags: [DisplayPort, DP 2.1, UHBR20, LTTPR, link training, DPCD, fallback]
level: advanced
prerequisites: ["DPCD 入門（posts/2026-10-29-dpcd-sink-capability.md）", "DP 2.1 UHBR 連結訓練失敗與 LTTPR 基礎（posts/2026-11-04-dp21-ltpr-uhbr-link-training-recovery.md）"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: senior
sources_checked: 2026-11-18
difficulty: advanced
---
上一篇談 LTTPR 時，我們把「發現、模式、fallback」的輪廓建立起來了。這篇往下挖一層：真的要設計一套能過 pre-compliance 的失敗回復狀態機時，新人最容易栽進去的三個坑——LTTPR 計數的 one-hot 解碼、Transparent/Non-Transparent 的切換序列、以及 fallback 階梯的順序。這三個坑的共同特徵是：程式碼看起來都會動，log 看起來都合理，只有接上中繼器、拉到 UHBR20 才會炸。

## 前置知識

先講 LTTPR 是什麼。LTTPR（Link Training Tunable PHY Repeater，連結訓練可調 PHY 中繼器）是 DP 路徑上的訊號中繼晶片，常見於 re-timer 中繼板、塢站、長距離主動式纜線。DP 2.1 把每通道速率拉到 UHBR10（10 Gbps）、UHBR13.5（13.5 Gbps）、UHBR20（20 Gbps），四條通道合計 40 Gbps 與 80 Gbps，對應 VESA 認證的 DP40 與 DP80 線材；DP80 線認證長度只保證到 1 米以上，訊號這麼脆，中間沒有中繼器根本撐不遠（VESA DP 2.1 新聞稿，2022-10-17）。

用接力賽比喻：8b/10b 時代的 link training 像兩個人之間直接傳接球，UHBR 加上 LTTPR 之後變成接力賽——來源端（source）到 LTTPR1 是第一棒，LTTPR1 到 LTTPR2 是第二棒，最後一棒才交給接收端（sink）。每一棒都要各自熱身（每段 link 區段各自做連結訓練，link training），不能只練第一棒就假設後面都沒事。

而 LTTPR 有兩種工作模式：Transparent（透明）模式像個只會偷聽的旁觀者，Non-Transparent（非透明）模式才是真正下場接球的隊友。速率拉到 UHBR 之後，中繼器必須以非透明模式運作，讓 source 對每一段 link 分別訓練、分別讀狀態。這些設定與狀態全部放在一塊獨立的 DPCD 位址區，叫 LTTPR DPCD field。

所有與 LTTPR 相關的 DPCD（DisplayPort Configuration Data，透過輔助通道（AUX）存取的設定與狀態暫存器空間）位址，公開可查的來源是 Linux kernel 的 `include/drm/display/drm_dp.h`：共用欄位從 0xF0000 起，每顆中繼器自己的暫存器從 0xF0010 起、每顆間隔 0x50，整條路徑最多 8 顆（`DP_MAX_LTTPR_COUNT` = 8）。本文另對照 VESA DP 2.0 規格頁碼（PDF 頁序）。

先講清楚角色：LTTPR 的發現、模式切換、逐段訓練與 fallback，都是 DPTX（source 端）的責任（DP 2.0 §3.6.6.1，PDF p.889）。對螢幕來說，這套狀態機用在有 DP-out（daisy chain）輸出埠的機種，或是塢站、轉接晶片這類 DPTX 角色；純 sink（DP-in）的 scaler 不會去讀寫 0xF0002／0xF0003，它的任務是在 LTTPR 後面正確回應 DPCD 與完成訓練。

## 技術核心

### 坑一：LTTPR 計數是 one-hot 位元型樣，不是二進位數字

LTTPR 發現（discovery）的第一步是讀共用欄位，kernel 的公開定義如下：

| DPCD 位址 | 名稱（kernel define） | 意義 |
|---|---|---|
| 0xF0000 | `DP_LT_TUNABLE_PHY_REPEATER_FIELD_DATA_STRUCTURE_REV` | LTTPR field 結構版本 |
| 0xF0001 | `DP_MAX_LINK_RATE_PHY_REPEATER` | 全部 LTTPR 的最低最大連結速率 |
| 0xF0002 | `DP_PHY_REPEATER_CNT` | 中繼器數量（one-hot 位元型樣） |
| 0xF0003 | `DP_PHY_REPEATER_MODE` | 模式（0x55 透明／0xAA 非透明） |
| 0xF0004 | `DP_MAX_LANE_COUNT_PHY_REPEATER` | 全部 LTTPR 的最低最大通道數 |
| 0xF0006 | `DP_MAIN_LINK_CHANNEL_CODING_PHY_REPEATER` | bit0 = 支援 128b/132b |
| 0xF0007 | `DP_PHY_REPEATER_128B132B_RATES` | 128b/132b 支援的速率 |

（位址與名稱出自 Linux kernel `drm_dp.h` 公開原始碼；0xF0002、0xF0003 的定義對照 DP 2.0 PDF p.575–576。）

新手最常犯的錯，是把 0xF0002 讀回來的值直接當二進位數字用，例如「低 3 位當數量」。它是 one-hot（單一位元為 1）型樣，而且從最高位元往下數：80h 代表 1 顆、40h 代表 2 顆、20h 代表 3 顆、10h 代表 4 顆、08h 代表 5 顆、04h 代表 6 顆、02h 代表 7 顆、01h 代表 8 顆，FFh 代表 9 顆以上，其他值保留（DP 2.0 PDF p.575）。kernel 的 `drm_dp_lttpr_count()` 用 population count（計算有幾個位元為 1）解碼：0 個位元為 1 就是 0 顆；恰好 1 個位元為 1，數量 = 8 減去位元位置；8 個位元全為 1（FFh）回 `-ERANGE`；其他型樣回 `-EINVAL`。也就是說，讀到 0x03、0x07 這種型樣不是「數量怪」，是「這次讀到的值不合法」。規格也明講：讀到合法值以外的數，DPTX 不得把模式寫成 AAh，也不得走 LTTPR 的訓練流程（DP 2.0 PDF p.889）。

為什麼這樣編？規格說每顆 LTTPR 回報的值是「從下游收到的值除以 2」，下游沒回應時預設 80h（PDF p.575）。所以每多一顆中繼器，位元就往右移一格，每顆中繼器只要做一次右移就好。順帶的好處是非法型樣很容易抓出來（個人經驗推論）。

### 坑二：模式切換要先「顯式回透明」，不能直接寫非透明

0xF0003 寫 0x55 是 Transparent、寫 0xAA 是 Non-Transparent（kernel `drm_dp.h` 公開定義；DP 2.0 PDF p.576）。直覺寫法是「要非透明就寫 0xAA」，但 DP 2.0 §3.6.6.1 的寫法是：要進非透明模式，先寫 55h、再寫 AAh；之後的訓練不必每次重做，除非偵測到下游拔插（PDF p.889）。kernel `drm_dp_lttpr_init()` 另外做了「設非透明失敗就回到透明」的處理。注意 128b/132b（UHBR）時 DPTX 必須把 LTTPR 設成非透明（PDF p.876），所以回到透明模式就等於只能走 8b/10b。

為什麼要多這一步？規格只規定序列，沒有寫理由。一個合理的解讀是：中繼器可能停留在上一次連結留下的非透明狀態，先寫 0x55 讓它回到已知起點（個人經驗推論）。kernel 的實作還有一個細節值得抄：設定失敗就回報錯誤，不帶著半設定的中繼器繼續往下訓練。

### 坑三：fallback 階梯先降頻率、不先減通道，重試門檻自己標明

128b/132b 時代的訓練圖樣與 8b/10b 完全不同（TPS2_CDS 取代了傳統 TPS2/TPS3 的角色，這點在之前的 CTS 文章驗證過），失敗回復的階梯也不一樣。VESA SF Workshop May 2025 公開簡報給的原則是：先降頻率（4L UHBR20 → 4L UHBR13.5 → 4L UHBR10），不要先減通道數；同 Link Config 可以重試 1–2 次，次數受 CDF（Capability Declare File，認證宣告檔）控制（VESA Taipei Workshop Oct 2025 公開簡報）。

把三個坑合起來，DPTX（source 端，或螢幕的 DP-out 埠）的失敗回復狀態機長這樣：

```
IDLE ──HPD──▶ LTTPR_DETECT ──count>0──▶ MODE_SEQ ──▶ TRAINING(CR→EQ/CDS)
                 │  │                                      │
                 │  └─count=0（直通 DPRX）                 ├─成功──▶ SUCCESS（背景監控）
                 │                                        ├─失敗<門檻──▶ 同 config 重試
                 └─AUX 失敗/非法型樣──▶ 當 0 顆重試         └─重試用盡──▶ FALLBACK
                                                                    │
                                              UHBR20→13.5→10→HBR3（先降頻率）
                                                                    │
                                                     全部失敗──▶ 停止並回報錯誤
```

對應的 C 語言骨架（DPCD 位址為 kernel 公開定義；scaler 內部暫存器與 AUX Macro 皆為示意）：

```c
/* ---- 已查證：LTTPR DPCD field（Linux kernel include/drm/display/drm_dp.h 公開定義）---- */
#define DPCD_LTTPR_REPEATER_CNT          0xF0002 /* DP_PHY_REPEATER_CNT（one-hot 位元型樣） */
#define DPCD_LTTPR_REPEATER_MODE         0xF0003 /* DP_PHY_REPEATER_MODE */
#define DPCD_LTTPR_MODE_TRANSPARENT      0x55    /* DP_PHY_REPEATER_MODE_TRANSPARENT */
#define DPCD_LTTPR_MODE_NON_TRANSPARENT  0xAA    /* DP_PHY_REPEATER_MODE_NON_TRANSPARENT */
#define DPCD_LTTPR_128B132B_CODING       0xF0006 /* bit0 = 支援 128b/132b */
#define DPCD_LTTPR_MAX_COUNT             8       /* DP_MAX_LTTPR_COUNT */

/* ---- 示意地址與暫存器，非實際晶片規格（scaler 內部暫存器）---- */
#define REG_DP_LINK_TRAIN_STATUS   0x3A14  /* 示意地址，非實際晶片規格 */

/* 讀 0xF0002 並做 one-hot 解碼（語意依 kernel drm_dp_lttpr_count()）。
 * 回傳 0 成功、-1 AUX 失敗或非法型樣。 */
static int dp_read_lttpr_count(uint8_t *count_out)
{
    uint8_t cnt_reg = 0;
    int i, bits_set = 0, one_hot_pos = -1;

    /* Scaler_Aux_Read 為示意 Macro，非實際晶片規格；DPCD 位址 0xF0002 已查證 */
    if (!Scaler_Aux_Read(DPCD_LTTPR_REPEATER_CNT, &cnt_reg, 1)) {
        return -1;
    }

    for (i = 0; i < 8; i++) {
        if (cnt_reg & (1u << i)) {
            bits_set++;
            one_hot_pos = i;
        }
    }

    if (bits_set == 0) {
        *count_out = 0;                          /* 無 LTTPR */
    } else if (bits_set == 1) {
        *count_out = (uint8_t)(8 - one_hot_pos); /* 0x80=1 顆、0x40=2 … 0x01=8（DP 2.0 p.575） */
    } else {
        return -1;   /* FFh（9 顆以上）或其他保留值：不得設 AAh、不得走 LTTPR 訓練（p.889） */
    }
    return 0;
}

/* 模式切換序列：DP 2.0 §3.6.6.1（PDF p.889）先寫 55h 再寫 AAh；
 * 失敗回到透明模式是 kernel drm_dp_lttpr_init() 的做法，回透明後只能走 8b/10b（p.876）。 */
static int dp_lttpr_mode_seq(void)
{
    /* 兩個 Scaler_Aux_Write 都是示意 Macro；0x55/0xAA 值已查證 */
    if (!Scaler_Aux_Write(DPCD_LTTPR_REPEATER_MODE, DPCD_LTTPR_MODE_TRANSPARENT)) {
        return -1;
    }
    if (!Scaler_Aux_Write(DPCD_LTTPR_REPEATER_MODE, DPCD_LTTPR_MODE_NON_TRANSPARENT)) {
        (void)Scaler_Aux_Write(DPCD_LTTPR_REPEATER_MODE, DPCD_LTTPR_MODE_TRANSPARENT);
        return -1;   /* 回滾失敗就回報，不帶半設定狀態繼續訓練 */
    }
    return 0;
}
```

fallback 階梯用一張由高到低的表驅動，順序就是規範建議的「先降頻率」：

```c
/* 128b/132b fallback：同通道數先降頻率（VESA SF Workshop May 2025 公開簡報）。
 * 同 Link Config 重試 1–2 次、受 CDF 控制（VESA Taipei Workshop Oct 2025）；
 * 程式裡的重試門檻是設計選擇（個人經驗推論），上線前用 HIL 實測標定。 */
static const struct { uint8_t rate_code; uint8_t lanes; } fallback_ladder[] = {
    { 0x14, 4 },   /* UHBR20，4 lanes（示意速率編碼，非晶片規格） */
    { 0x0F, 4 },   /* UHBR13.5，4 lanes（示意速率編碼，非晶片規格） */
    { 0x0A, 4 },   /* UHBR10，4 lanes（示意速率編碼，非晶片規格） */
    { 0x1E, 4 },   /* HBR3 8.1 Gbps，4 lanes（示意速率編碼；改走 8b/10b，LTTPR 可回透明） */
};
```

最後一級也失敗時，DPTX 端沒有 HPD 可以拉（HPD 是下游 sink 驅動的訊號），只能停止並回報錯誤。如果是螢幕的 DP-in（sink）端想請上游 source 重來，才用 HPD 拉低超過 2 ms 的拔插事件；IRQ_HPD 則是 0.5–1.0 ms（DP 2.0 PDF p.65、p.717）。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 4K144 等級的 DP 2.1 機種有 DP-out（daisy chain）輸出埠，DVT 階段從 DP-out 接第二台螢幕驗證，直插一切正常，透過內建 re-timer 的主動式 DP80 線測試時，UHBR20 訓練間歇性失敗：有時開機黑屏十幾秒後降級到 HBR3，有時直接無訊號。第一時間大家都懷疑線材或 PHY 硬體，量測與協定層分析卻指向韌體：

- 量測現象一：AUX 讀 0xF0002 回 0x01，韌體把它當「1 顆中繼器」，實際拓樸是 8 顆（one-hot 語意）。中繼器沒進非透明模式，source 對整條路徑做單段訓練，等化在中繼器後面直接崩。
- 量測現象二：韌體直接寫 0xF0003 = 0xAA，偶爾中繼器不回應；重試又直接寫 0xAA，卡在半設定狀態，AUX 開始 NACK。
- 量測現象三：訓練失敗後 DP-out 韌體先試 2-lane UHBR20，下游螢幕需要的頻寬不夠，反覆循環到 timeout。

三個現象對應本文三個坑。修正後（one-hot 解碼＋先透明後非透明序列＋頻率優先階梯），同一批線材與拓樸的 UHBR20 訓練收斂，失敗時也能在階梯內乾淨降級。這個案例的每個細節都是依公開規格與 kernel 公開實作推演的教學情境，但坑本身在實驗室裡天天見——差別只在你的專案踩到哪一個。

## 新人避坑指南

1. **把 kernel 當你的免費交叉參考**：DP 規格全文要 VESA 會員資格，但 Linux kernel 的 `drm_dp.h` 與 `drm_dp_helper.c` 是公開的，是很好的交叉參考（但不等於規格本身，有疑問仍以規格為準）。寫 LTTPR 程式碼之前，先讀 `drm_dp_lttpr_count()`、`drm_dp_lttpr_init()` 這幾個函式，比猜暫存器語意可靠得多。
2. **看到「計數」欄位先別急著當數字**：0xF0002 是 one-hot 型樣。寫解碼函式時順便做型樣檢查（population count 不是 0 或 1 就回錯誤），這個防禦在 AUX 讀值被污染時會救你一命。
3. **模式切換寫成序列，不要寫成單一寫入**：先 0x55 再 0xAA，失敗回滾 0x55。把序列包成一個函式，所有訓練重試都從同一個入口走，避免有人「順手優化」掉第一步。
4. **fallback 階梯做成表**：由高到低排序、只放合法組合（同通道數降頻率），重試次數與門檻集中定義並標明出處（規格明訂、官方簡報、還是設計選擇）。認證前對照 CDF 檢查重試次數宣告。
5. **驗證矩陣至少三種拓樸**：無中繼器直插、單顆 LTTPR、多顆 LTTPR（或主動式長線）。直插永遠測不出這三個坑，因為它們全部只在「路徑上有中繼器」時發作。
6. **log 要能回答「當時讀到什麼」**：0xF0002 原始值、模式序列每一步的回應、每次訓練失敗的階段與重試編號，全部進 log。客退分析時，這些數字就是 8D 報告的根因證據。

## 思考題

0xF0002 用一個位元代表一種數量（80h = 1 顆 … 01h = 8 顆），而不是用 4-bit 二進位數字直接表達 0–8。為什麼規格要這樣設計？如果路徑上有 9 顆中繼器，DPTX 會讀到什麼、應該怎麼做？

提示：查 DP 2.0 PDF p.575 對「從 DFP 收到的值除以 2」的規定，以及 p.889 對非法值的處理。

<details>
<summary>參考方向（先自己查再開）</summary>
每顆 LTTPR 把下游回報的值右移一位（除以 2）往上傳，最下游沒有回應時預設 80h，所以每多一顆，位元就往右移一格；收到 01h 或 FFh 時回報 FFh（PDF p.575）。9 顆以上會讀到 FFh（kernel 回 -ERANGE），規格規定此時 DPTX 不得設 AAh、不得走 LTTPR 訓練流程（PDF p.889）。順帶的好處是非法型樣容易被偵測（推論）。
</details>

## 參考資料

1. VESA DisplayPort Standard Version 2.0（VESA 會員文件，本文只引用頁碼）：PHY_REPEATER_CNT 編碼（PDF p.575）、PHY_REPEATER_MODE（PDF p.576）、128b/132b 必須非透明（PDF p.876）、§3.6.6.1 55h→AAh 序列與非法值處理（PDF p.889）、HPD 時序（PDF p.65、p.717）。
1. Linux kernel `include/drm/display/drm_dp.h`（LTTPR DPCD 公開定義：0xF0000–0xF0008、0x55/0xAA、LTTPR(n) = 0xF0010 + 0x50×(n-1)、`DP_MAX_LTTPR_COUNT` = 8）：https://github.com/torvalds/linux/blob/master/include/drm/display/drm_dp.h （官方原始碼）
2. Linux kernel `drivers/gpu/drm/display/drm_dp_helper.c`（`drm_dp_lttpr_count()` one-hot 解碼、`drm_dp_lttpr_init()` 依 DP v2.0 §3.6.6.1 的模式切換序列與回滾）：https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/display/drm_dp_helper.c （官方原始碼）
3. VESA 新聞稿「VESA Releases DisplayPort 2.1 Specification」（2022-10-17：UHBR10 = 10 Gbps/lane ×4 lanes = 40 Gbps（DP40 線）、UHBR20 = 20 Gbps/lane ×4 lanes = 80 Gbps（DP80 線）、DP40 線認證長度 2 米以上、DP80 線 1 米以上）：https://vesa.org/featured-articles/vesa-releases-displayport-2-1-specification/ （官方）
4. Unigraf「Brief Introduction to DisplayPort LTTPRs」（LTTPR DPCD field 0xF0000h–0xF028Fh 範圍、Recognition 與 Link Training 階段）：https://www.unigraf.fi/app/uploads/2020/02/Introduction-to-Link-Training-Tunable-PHY-Repeaters-LTTPR.pdf （測試儀器廠公開文件，非官方規格）
5. VESA SF Workshop May 2025（128b/132b fallback 頻率優先於通道數、同 Link Config 重試 1–2 次受 CDF 控制）：https://vesa.org/wp-content/uploads/2025/06/VESA-SF-Workshop_May-2025.pdf （官方簡報）
6. VESA Taipei Workshop Oct 2025（DP2.1x CTS：INTRAHOP_AUX_REPLY_INDICATION @DPCD 102h、LTTPR Device Tests）：https://vesa.org/wp-content/uploads/2025/10/VESA-Taipei-Workshop_Oct-2025.pdf （官方簡報）
7. Cadence 社群部落格「DisplayPort 128b/132b Concurrent LTTPR Link Training - Verification」（並行 LTTPR 訓練、CDS/Hop/Intra-Hop Aux、650 ms 訓練目標）：https://community.cadence.com/cadence_blogs_8/b/fv/posts/displayport-128b-132b-concurrent-lttpr-link-training （EDA 廠技術部落格，非官方規格）

> 本文規格頁碼對照 VESA DP 2.0（PDF 頁序）；DP 2.1／2.1b 的差異未核對（待查證），實作前請對照最新版規格與 scaler SDK。
