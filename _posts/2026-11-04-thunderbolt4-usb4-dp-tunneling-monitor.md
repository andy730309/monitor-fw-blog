---
layout: post
title: "接上 Thunderbolt 塢站就閃黑？USB4 DP tunneling 讓 monitor 韌體踩到的三個坑"
date: 2026-11-04
tags: [USB4, Thunderbolt, DP tunneling, DPCD, AUX, HPD, DSC]
level: advanced
prerequisites: ["DPCD 入門：DisplayPort 設定資料結構與 Sink Capability 宣告", "Type-C 一線通影像不進入 DP Alt Mode？VDM 流程、pin assignment 與 HPD/Attention 三個坑", "CTS 說你 UHBR10 沒過？128b/132b link training 的 CDS 階段與 DP 2.1 認證工具矩陣"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: senior
sources_checked: 2026-11-04
description: "接上 Thunderbolt 塢站就閃黑？說明 USB4 DP tunneling 下，monitor 韌體在 AUX、link 訓練與 HPD 的三個責任。"
seo_title: "Thunderbolt 塢站閃黑？USB4 DP tunneling 三個坑"
difficulty: advanced
---
> **重點摘要**：USB4 把 DP 流量打包成 tunnel，螢幕只看得到 dock 出來的那段 link，頻寬由別人分配，AUX 回應時間也會被 tunnel 吃掉。monitor 韌體有三個責任：AUX 回應不能超出預算、任何 rate 與 lane 組合都要能訓練、不要把 HPD 當 reset 按鈕。

Monitor 韌體工程師很容易把 USB4 當成「別人的事」：那是 host 的 connection manager、dock 的韌體、GPU 驅動在管的。直到客戶接上 Thunderbolt 塢站，螢幕每五秒黑一次，你才發現 monitor 雖然看不到 tunnel，卻能用自己的 HPD 和 AUX 行為把 tunnel 玩壞。

這篇把 USB4／Thunderbolt 的 DP tunneling 拆成 monitor 端能理解的三件事：你只看得到第二段 link、頻寬是別人分配的、你的 AUX 回應時間會被 tunnel 吃掉。規格數字都對得到本地 USB4 2.0 與 DP 2.0 文件，沒查到的地方會標「待查證」。

## 前置知識

先別背暫存器，先用快遞轉運站想一遍。

GPU 想把畫面送到螢幕，但中間隔著一條 USB4 線和一台 dock。USB4 的做法不是把 DP 訊號原封不動拉過去，而是把它「打包」成 tunnel：GPU 端有一個 **DP IN Adapter** 負責把 DP 流量吸進 USB4 fabric，dock 端有一個 **DP OUT Adapter** 負責把流量倒出來，變成一般的 DP 訊號給螢幕。對螢幕來說，DP OUT Adapter 就是它的 source；它根本不知道上游有 tunnel。

![圖 1．DP 經 USB4 tunnel 到螢幕的兩段 link](/monitor-fw-blog/assets/img/posts/thunderbolt4-usb4-dp-tunneling-monitor/fig-1.svg)

圖 1．DP 經 USB4 tunnel 到螢幕的兩段 link

這個架構有兩個直接後果。

第一，**兩段 link 是分開談的**。在 TBT3-compatible 模式下，USB4 規範要求兩段循序訓練：DP OUT Adapter 要等 DP IN Adapter 那邊訓練完，才開始訓練到螢幕這一段（USB4 2.0 PDF p.798）。所以螢幕看到的 link rate，是 dock 在「tunnel 預算」和「螢幕能力」之間取完最小值之後的結果，不是 GPU 原本想要的速率。

第二，**monitor 的 DPCD 與 EDID 是隔着 tunnel 被讀的**。AUX 請求會先被封裝、傳過 fabric、再從 DP OUT Adapter 發出來。USB4 規範給這段傳輸的延遲上限是：DP IN 45 µs、DP OUT 10 µs（USB4 2.0 PDF p.709）。而 DP 規範要求 DPRX 在 300 µs 內開始回應 AUX（DP 2.0 PDF p.382）。這兩個數字放在一起，就是 monitor 韌體的時間預算。

還有一個名詞要先分清楚：**TBT3-compatible 模式**。這不是「插上 Thunderbolt 3 線」這麼簡單，它是 DP Adapter 的一種運作模式。在這個模式下，USB4 規範明文要求 DP IN Adapter 把 DSC Support 與 FEC_CAPABLE 固定為 0（USB4 2.0 PDF p.796）。也就是說，走這條路不會有 DSC。原生 USB4 模式則把 DSC/FEC 的 discover 與 enable 流程當成 AUX pass-through 處理（USB4 2.0 PDF p.589），adapter 要求表也寫「DSC Required if UHBR is supported」（PDF p.596）。

## 技術核心

### 頻寬不是免費的：CM 先分帳，dock 再談 link

USB4 的頻寬由 host 的 connection manager（CM）分配。以 Windows 的公開說明為例：USB4 link 最多 90% 可以明確分配給 USB3、PCIe 與 DP；USB3 與 PCIe 先按 2/3、1/3 分；DP tunnel 建立時依 DP IN/DP OUT adapter 的能力預留，若作業系統支援 DP bandwidth allocation mode，CM 會把估計可用頻寬寫進 `ESTIMATED_BW`、已分配頻寬寫進 `ALLOCATED_BW`；不支援這個模式時就採先到先贏，頻寬不夠就把 DP capabilities mask 掉，連最低組態都放不下時 tunnel 直接建立失敗（Microsoft Learn，USB4 design details）。

對 monitor 來說，這些都是黑盒子。但除錯時要知道兩個 DPCD 欄位的存在：

| DPCD | 欄位 | 意義 |
|---|---|---|
| E0023h | ESTIMATED_BW | CM 估計可用頻寬 |
| E0024h | ALLOCATED_BW | 已分配頻寬 |
| E0028h | DP_TUNNELING_MAX_LINK_RATE | tunnel 允許的最大 link rate |
| E0029h | DP_TUNNELING_MAX_LANE_COUNT | tunnel 允許的最大 lane count |
| E0031h | REQUESTED_BW | DPTX 要求分配的頻寬 |

（USB4 2.0 PDF p.699–p.700，Table 10-24；p.627 說明 E0028h/E0029h 是 DPRX 宣告與 adapter 上限取最小值。）

這些暫存器在 DPTX 側，monitor 讀不到。它們的價值是讓你跟 host/dock 團隊吵架時有共同語言：看到 HBR2×4，先問「當時 USB3 與 PCIe 吃了多少」，而不是直接改 EDID。

### 為什麼 TB3 塢站上 4K144 不見了

這題常被誤判成 FW bug。事實是：TBT3-compatible 模式沒有 DSC（USB4 2.0 PDF p.796）。沒有 DSC，HBR3×4 的應用頻寬是 3240 MBps，換算 25.92 Gbps（DP 2.0 PDF p.80，Table 1-6）。4K144 10bpc 只算 active pixel 就要：

```
3840 × 2160 × 144 × 30 bit/s = 35.83 Gbps
```

35.83 Gbps 大於 25.92 Gbps，差距約 38%。這還沒算 blanking 與協定 overhead。所以在 TB3-compatible tunnel 上，4K144 不是「韌體再調一下」就能出來，是物理與規範上都不成立。原生 USB4 模式有 DSC pass-through，才有機會。

這也意味著產品規格書要分清楚：「支援 4K144」是在 direct DP Alt Mode 與原生 USB4 路徑下成立，不是在任何 TB3 塢站下都成立。業務話術與 FW 能力要對齊，不然 DVT 尾聲一定有人拿石頭砸自己腳。

### Monitor 端的三個責任

Monitor 不能管 tunnel，但能決定自己在第二段 link 上好不好相處。三個責任如下。

#### 責任一：AUX 回應不能超過預算

DPRX 收到 AUX request 後，必須在 300 µs 內開始回應（DP 2.0 PDF p.382）。這個時間是給 source 的 reply timeout 用的；monitor 如果每次都去 flash 讀 EDID、拼 block、算 checksum，再順手印一行 UART log，很容易把 300 µs 吃掉。Direct 連線可能還撐得住，經過 tunnel 就開始間歇 timeout。

正確做法是把 EDID 變成 RAM 裡的 shadow，改版時在背景重建，完成後一次交換；AUX handler 只做固定時間的 memcpy。

```c
/* edid_shadow.c — EDID 以 RAM shadow 提供，AUX handler 不碰 flash
 * DPCD / I2C-over-AUX 位址為公開定義（DP 2.0 PDF p.382；E-DDC 0x50）。
 * Scaler_* 與 REGADDR_* 為示意地址，非實際晶片規格。 */
#define EDID_BYTES 256u

static uint8_t g_edid_buf[2][EDID_BYTES];
static volatile uint8_t g_edid_active;
static volatile uint8_t g_edid_ready;

static uint8_t edid_block_sum(const uint8_t *blk)
{
    uint16_t s = 0;
    for (uint8_t i = 0; i < 127u; i++)
        s += blk[i];
    return (uint8_t)(0u - (uint8_t)s);   /* 128 bytes 總和 ≡ 0 (mod 256) */
}

int Edid_Commit(const uint8_t *src, uint16_t len)
{
    uint8_t next = (uint8_t)(g_edid_active ^ 1u);

    if (len == 0u || len > EDID_BYTES || (len % 128u) != 0u)
        return -1;

    memcpy(g_edid_buf[next], src, len);
    for (uint16_t off = 0; off < len; off += 128u)
        g_edid_buf[next][off + 127u] = edid_block_sum(&g_edid_buf[next][off]);

    g_edid_active = next;               /* 先寫完才切 */
    g_edid_ready  = 1u;
    return 0;
}

/* AUX handler：只做 memcpy，不讀 flash、不 malloc、不印 log */
int Edid_Read(uint8_t off, uint8_t *out, uint8_t len)
{
    if (!g_edid_ready)
        return -1;
    if ((uint16_t)off + len > EDID_BYTES)
        return -1;

    memcpy(out, &g_edid_buf[g_edid_active][off], len);
    return (int)len;
}
```

#### 責任二：任何 rate/lane 組合都要能訓練

Dock 可能因為 tunnel 預算把第二段 link 降到 HBR2×4 或 HBR3×2。如果你的 receive equalizer 只針對 HBR3×4 標定，其他組合就是拿預設值硬撐。更常見的錯是：訓練失敗後只重寫 `TRAINING_PATTERN_SET`（DPCD 0x102），沒有清掉上一次的 `LANE0_1_STATUS`（0x202）與 `LANE_ALIGN_STATUS_UPDATED`（0x204），source 讀到 stale 的 EQ done，誤判成功或反覆重試。

```c
/* dprx_link.c — latch 公開 DPCD 0x100/0x101/0x102，按速率換 RX EQ
 * 0x100 LINK_BW_SET、0x101 LANE_COUNT_SET、0x102 TRAINING_PATTERN_SET
 * （DP 2.0 PDF p.467–p.469）；0x202/0x204 狀態（DP 2.0 PDF p.490）。
 * Dprx_* 與 REGADDR_* 為示意，非實際晶片規格。 */
typedef struct {
    uint8_t bw_code;
    uint8_t lanes;
    uint8_t rx_eq_level;   /* 示意，實際由 eye diagram 標定 */
} rx_profile_t;

static const rx_profile_t g_rx_profiles[] = {
    { 0x1E, 4, 3 },   /* HBR3 x4 */
    { 0x1E, 2, 2 },   /* HBR3 x2 */
    { 0x14, 4, 2 },   /* HBR2 x4 */
    { 0x14, 2, 1 },   /* HBR2 x2 */
    { 0x0A, 4, 1 },   /* HBR  x4 */
    { 0x06, 4, 0 },   /* RBR  x4 */
};

static uint8_t g_link_bw;
static uint8_t g_lane_count;

static void Dprx_ApplyRxEq(uint8_t bw, uint8_t lanes)
{
    for (uint8_t i = 0; i < sizeof(g_rx_profiles) / sizeof(g_rx_profiles[0]); i++) {
        if (g_rx_profiles[i].bw_code == bw && g_rx_profiles[i].lanes == lanes) {
            Scaler_Write_Register_Byte(REGADDR_DPRX_EQ /* 示意 */,
                                       g_rx_profiles[i].rx_eq_level);
            return;
        }
    }
    Scaler_Write_Register_Byte(REGADDR_DPRX_EQ /* 示意 */, 0);  /* 保守值 */
    Log_Event(EVT_DP_UNKNOWN_LINK_COMBO, ((uint16_t)bw << 8) | lanes);
}

static void Dprx_ResetTrainingState(void)
{
    Dprx_WriteDpcd(0x202, 0x00);   /* 清 stale status */
    Dprx_WriteDpcd(0x203, 0x00);
    Dprx_WriteDpcd(0x204, 0x00);
    Dprx_ApplyRxEq(g_link_bw, g_lane_count);
}

void Dprx_OnLinkConfigWrite(uint8_t addr, uint8_t val)
{
    switch (addr) {
    case 0x100:
        g_link_bw = val;
        Dprx_ResetTrainingState();
        break;
    case 0x101:
        g_lane_count = (uint8_t)(val & 0x0Fu);
        Dprx_ResetTrainingState();
        break;
    case 0x102:
        Dprx_SetTrainingPattern((uint8_t)(val & 0x0Fu));
        break;
    default:
        break;
    }
}
```

#### 責任三：HPD 不是 reset 按鈕

訓練失敗時，很多 FW 的直覺反應是 toggle HPD。在 direct 連線下這只是重來一次；在 USB4 路徑下，HPD 變化會讓 DP OUT Adapter 重新讀 DPRX capabilities、更新 `DP_LOCAL_CAP`，而且規範要求它至少等 150 ms 才送 Hot Plug Event（USB4 2.0 PDF p.797）。你每 1 秒 toggle，就等於每 1 秒叫 CM 拆一次 tunnel、重建一次 AUX path，黑畫面就變成週期性的。

比較好的順序是：先送 IRQ_HPD（0.5–1.0 ms 的低脈衝，DP 2.0 PDF p.717），語意是「請 source 重讀 link status」；真的需要重新列舉時才 full HPD，而且要有最小間隔與次數上限。

```c
/* hpd_policy.c — 訓練失敗先 IRQ_HPD，再退避；2 s / 3 次為設計值，非規格 */
typedef enum { HPD_IDLE, HPD_IRQ_SENT, HPD_BACKOFF, HPD_FULL } hpd_state_t;

static hpd_state_t g_hpd_state = HPD_IDLE;
static uint8_t     g_fail_cnt;
static uint32_t    g_t_last_ms;

void Hpd_OnTrainingFail(void)
{
    uint32_t now = Tick_Ms();
    uint32_t elapsed = now - g_t_last_ms;

    if (g_fail_cnt < 3u && elapsed > 2000u) {
        Dprx_DriveHpdIrqPulse();          /* 0.5–1.0 ms，示意實作 */
        g_hpd_state = HPD_IRQ_SENT;
    } else if (elapsed > 2000u) {
        Dprx_DriveHpdLow();
        Delay_Ms(2);                      /* 設計值，非規格 */
        Dprx_DriveHpdHigh();
        g_hpd_state = HPD_FULL;
        g_fail_cnt = 0;
    } else {
        g_hpd_state = HPD_BACKOFF;
        return;
    }

    g_fail_cnt++;
    g_t_last_ms = now;
}
```

### DSC 宣告要誠實

最後補一個常被忽略的點：DSC capability 不是行銷欄位。`0x060` 宣告支援、`0x064` 宣告 slice 數、`0x065` 宣告 line buffer、`0x067/0x068` 宣告 bpp 上限（DP 2.0 PDF p.270）。這些值必須由同一份 panel 參數表生成；開機時驗證，任何一項為 0 或超出表範圍，就寧可不要宣告。宣告了卻放不下，host 只會算出一個做不到的 stream，然後把問題丟回給你。

```c
/* dsc_caps_check.c — 開機自查；DPCD 位址為公開定義（DP 2.0 PDF p.270） */
static int DscCaps_Consistent(void)
{
    const panel_dsc_t *p = Panel_GetDsc();

    if (p == NULL)
        return 1;                     /* 不宣告就沒有不一致問題 */
    if (p->slices == 0u || p->slice_width == 0u || p->line_buf_bits == 0u)
        return 0;
    if (p->max_bpp_x16 < p->min_bpp_x16)
        return 0;
    return 1;
}

void DscCaps_Init(void)
{
    if (!DscCaps_Consistent()) {
        Dprx_WriteDpcd(0x060, 0x00);
        Log_Event(EVT_DSC_CAPS_MISMATCH, 0);
        return;
    }
    /* 由 panel 參數表寫入 0x060 / 0x064 / 0x065 / 0x067 / 0x068 */
    Panel_ProgramDscCaps();
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 ODM 的 32 吋 4K144 Type-C 一線通機種，DVT 尾聲收到三種回饋：

1. **TB3 塢站上 4K144 不見了。** 業務在投標文件寫了 4K144，客戶拿 TB3 筆電一插只剩 4K60，要求解釋。這個不是 FW bug：TBT3-compatible 模式 DSC 被強制為 0（USB4 2.0 PDF p.796），HBR3×4 的 25.92 Gbps 放不下 4K144 10bpc 的 35.83 Gbps。
2. **USB4 塢站加外接 NVMe 與 2.5GbE，畫面每 5–10 秒黑約 1 秒。** 拔掉 SSD 就恢復。量測發現 DP link 有時 HBR3×4、有時 HBR2×4；黑畫面與 HPD 抖動同步。根因有兩層：一是 training profile 只有 HBR3×4，降到 HBR2×4 時 RX EQ 用預設值，CR 容易失敗；二是失敗後每 1 秒 full HPD toggle，DP OUT Adapter 依規範要重新讀 DPRX cap、至少等 150 ms 再送 Hot Plug Event（USB4 2.0 PDF p.797），CM 於是把 tunnel 拆掉重建。Monitor 自己把一次訓練失敗放大成持續斷線。
3. **透過塢站讀 EDID 間歇 timeout。** AUX analyzer 抓到 monitor 回應超過 300 µs（DP 2.0 PDF p.382）。原因是 AUX handler 每次請求都去 flash 讀表、拼 EDID、算 checksum。Direct 連線時勉強過關，經過 tunnel 多了 DP IN 45 µs 與 DP OUT 10 µs 的傳播延遲（USB4 2.0 PDF p.709），就開始掉。

三個症狀，對應三個不同層次：規範層（TBT3 沒有 DSC，這是產品定義問題）、link 層（rate/lane 矩陣與 stale status）、協定層（AUX 時間預算與 HPD 語意）。如果只改 EDID，第 2 個症狀不會好；如果只改 HPD，第 3 個症狀還是會偶發。

## 新人避坑指南

1. **先分層再改 code**：direct 正常、經 dock 異常，先查 tunnel 與 dock，不要第一時間動 EDID。Linux 可用 `boltctl`、`dmesg` 的 thunderbolt tunnel event（activated / changed / deactivated / low bandwidth / insufficient bandwidth）確認狀態；Windows 可看 USB4 設定與事件檢視器。
2. **建 link rate × lane 矩陣**：RBR / HBR / HBR2 / HBR3 × 1 / 2 / 4 lanes，每一格都要能訓練。只測 native HBR3×4 等於沒測。
3. **量 AUX 回應時間**：用 AUX analyzer 或 logic analyzer 抓 DPRX 從 STOP 到 reply 的時間。規範上限是 300 µs（DP 2.0 PDF p.382），tunnel 路徑要另外量。
4. **EDID 路徑去阻塞**：AUX handler 內禁止 flash read、malloc、UART log、mutex 等待。EDID 用 RAM shadow＋checksum＋單一 commit。
5. **HPD 去抖與退避**：訓練失敗先 IRQ_HPD；full HPD 要有最小間隔與次數上限；EDID 更新期間禁止 HPD。
6. **DSC 宣告自查**：`0x060/0x064/0x065/0x067/0x068` 由同一份 panel 參數表生成，開機驗證，不一致就關掉宣告。
7. **Dock 壓力測試**：4K144 同時跑 USB3 SSD、2.5GbE，觀察是否降到 4K60 或黑屏。這是 tunnel 頻寬預算的正常壓力，不是單純 DUT 問題。
8. **分清楚 TB3-compatible 與原生 USB4**：TB3-compatible 模式沒有 DSC，別在 TB3 dock 上承諾 4K144；原生 USB4 才有 DSC/FEC pass-through。
9. **量測記錄要留隧道證據**：dock 型號、host 平台（不寫品牌）、USB4/TB 模式、當下 USB3 負載、DP link rate/lane、`E0028h/E0029h`（若可讀）。客訴分析才不會各說各話。
10. **認證前先跑互操作**：USB4CV 的 DP Tunneling CTS 與 USB4 Interoperability Test Procedures 是公開項目（USB-IF 合規頁），但 monitor 是 sink，實際遇到的是 dock/host 組合；自建互操作矩陣比祈禱有用。

## 思考題

你的 4K144 機種在 direct USB-C 與原生 USB4 塢站上都正常，只有在某台 TB3 塢站上掉到 4K60；客戶堅持這是 FW bug，要求你「把 4K144 開回來」。請用公開規格回答三件事：TB3-compatible 模式下 DSC 的狀態是什麼？HBR3×4 的應用頻寬是多少？4K144 10bpc 至少需要多少頻寬？如果你的答案支持「開不回來」，你會怎麼跟客戶談產品規格與替代方案（例如原生 USB4 路徑、或降到 4K120 8bpc）？

<details>
<summary>提示</summary>

TB3-compatible 模式下 DP IN Adapter 的 DSC Support 與 FEC_CAPABLE 固定為 0（USB4 2.0 PDF p.796）；HBR3×4 應用頻寬 3240 MBps = 25.92 Gbps（DP 2.0 PDF p.80）；4K144 10bpc active pixel 下限 35.83 Gbps。三個數字對完，就知道這不是 FW 能變出來的魔術，而是產品規格要分路徑講清楚。
</details>

## 參考資料

本地規格（/workspace/specs）：

1. USB4 Specification 2.0 November 2025（USB Promoter Group）
   - §10.4.9 DSC and FEC Enable，PDF p.589
   - DP Adapter 要求表（BW Allocation Mode Required、DPRX Discovery Required、DSC Required if UHBR supported），PDF p.596
   - Table 10-9 HPD Event Propagation Delay Requirements，PDF p.619
   - Table 10-12 AUX Delay Requirements、Table 10-28 DP Adapter Timing Parameters，PDF p.626、p.709
   - Table 10-24 DPCD Bandwidth Allocation Registers，PDF p.699–p.700
   - DP_TUNNELING_MAX_LINK_RATE / MAX_LANE_COUNT 聚合規則，PDF p.627
   - §13.8.1 AUX Handling（TBT3-compatible 模式 DSC Support=0、FEC_CAPABLE=0），PDF p.796
   - §13.8.2 IRQ Handling、§13.8.3.1 Connection Manager Discovery（等待 ≥150 ms 後送 Hot Plug Event），PDF p.797
   - §13.8.6 DisplayPort Link Training（兩段 link 循序訓練）、Table 13-24，PDF p.798–p.800
2. VESA DisplayPort Standard 2.0
   - Table 1-6 DP Main-Link Application Bandwidth，PDF p.80
   - DSC Capabilities（DPCD 00060h 起），PDF p.270
   - §2.11.2 AUX Transaction Response/Reply Timeouts（300 µs），PDF p.382
   - LINK_BW_SET 00100h / LANE_COUNT_SET 00101h / TRAINING_PATTERN_SET 00102h，PDF p.467–p.469
   - LANE0_1_STATUS 00202h / LANE_ALIGN_STATUS_UPDATED 00204h，PDF p.490
   - IRQ_HPD pulse 0.5–1.0 ms，PDF p.717

公開網頁（官方）：

3. USB-IF：USB4 技術頁 — https://www.usb.org/usb4 （官方）
4. USB-IF：USB4 Specification v2.0 下載頁 — https://www.usb.org/document-library/usb4tm-specification （官方）
5. USB-IF：USB4 Compliance（USB4CV CTS 含 DP Tunneling CTS、Interoperability Test Procedures）— https://www.usb.org/usb4compliance （官方）
6. Microsoft Learn：USB4 design details and general requirements — https://learn.microsoft.com/en-us/windows-hardware/design/component-guidelines/usb4-design-details-and-general-requirements （官方）
7. Linux Kernel Documentation：USB4 and Thunderbolt — https://docs.kernel.org/admin-guide/thunderbolt.html （官方）

非官方、僅用於交叉理解（未作為數字來源）：

8. Linux kernel `include/drm/display/drm_dp.h`（DPCD 位址定義）— https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/drm/display/drm_dp.h （非官方，開源）

待查證：各家 dock 的 CM 實作差異、原生 USB4 模式下 DSC PPS 是否在所有 dock 都完整 pass-through、Thunderbolt 5 Bandwidth Boost 對 DP tunnel 的實際分配、TBT3-compatible 模式下 host 端是否一定停用 DSC、4K144 10bpc 在各種 DSC slice 組合下的 panel 實測值。
