---
layout: post
title: "訓練成功不是終點：HDMI FRL rate mismatch 與 SCDC 錯誤監控的三個坑"
date: 2026-11-13
tags: [HDMI, FRL, SCDC, Link Training, EDID, Monitor Firmware]
level: intermediate
prerequisites: ["posts/2026-11-01-hdmi-frl-link-training-scdc.md"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-13
difficulty: intermediate
---
上一篇我們處理了 FRL 連結訓練（link training）本身的握手問題：sink 什麼時候 set FLT_UPDATE、什麼時候閉嘴。這篇要講的是更陰險的一層：訓練「成功」之後才爆的東西。三個症狀，一根共同的病：韌體把訓練成功當終點，把 SCDC 當成一條用完就丟的通道，而不是一台需要持續盯著的儀表板。

## 前置知識

先把名詞講清楚。來源端（source）就是 GPU、遊戲機、機上盒；接收端（sink）就是你的螢幕。

SCDC（Status and Control Data Channel，狀態與控制資料通道）是 HDMI 2.0 引入的機制：source 和 sink 之間用同一條讀 EDID 的 I2C 匯流排交換狀態與控制資料，slave address 是 0x54。這是 Linux kernel `drm_scdc_helper.c` 文件註解開宗明義寫的，也是整個 FRL 時代的控制面骨幹。FRL（Fixed Rate Link）模式下，訓練的進度、錯誤計數、降級請求，全部走這條通道。

用工程類比：EDID 是螢幕的身分證，插上線的時候讀一次就完事；SCDC 比較像是駕駛座前的儀表板，引擎（link）發動之後，轉速、水溫、故障燈都要即時回報。你可以想像一台車把儀表板拆了只留引擎，開到一半水溫爆表你也不會知道，直到引擎縮缸。雪花雜訊然後黑畫面，就是縮缸。

FRL 訓練的關鍵角色回顧（細節見上一篇）：

- sink 在 SCDC 0x40 的 bit6 set FLT_READY，告訴 source「我準備好了，可以開始訓練」。
- source 把要用的 rate 寫進 SCDC 0x31：bit[3:0] 是 FRL_RATE，bit[7:4] 是 FFE_LEVELS。
- 訓練過程中，sink 在 0x41/0x42 的 Ln(x)_LTP_req 欄位（每 lane 4 bit）寫入請求，改完就 set 0x10 的 FLT_update，source 讀完寫 1 清除。0x41/0x42 對 source 是唯讀（HDMI 2.1 PDF p.364）。編碼：0＝不要 pattern、1–8＝LTP1–LTP8、0xE＝請 source 提高該 lane 的 TxFFE、0xF＝請 source 換 rate（所有 active lane 要同時寫 0xF）（Table 6-32，PDF p.98）。
- 所有 active lane 都寫 0，代表訓練完成；source 開始送 FRL，sink 確認收到後 set FRL_start（PDF p.102、p.104）。FLT_ready 不用清：規格只要求 sink 在「無法做 FRL」時才清（PDF p.364）。

FRL rate 的編碼值，Linux kernel `drm_scdc_helper.h` 的 `enum drm_scdc_frl_rate` 定義得很清楚：0 是關閉、1 是 3 Gbit/s × 3 lanes、2 是 6 Gbit/s × 3 lanes、3 是 6 Gbit/s × 4 lanes、4 是 8 Gbit/s × 4 lanes、5 是 10 Gbit/s × 4 lanes、6 是 12 Gbit/s × 4 lanes，7 到 15 保留，與 HDMI 2.1 規格 0x31 FRL_Rate 欄位定義一致（PDF p.361）。這張表和 EDID HF-VSDB 裡的 Max_FRL_Rate 是同一套編碼（PDF p.347），也是本篇第一個坑的裁判依據。

## 技術核心

### 坑一：rate mismatch 沒有防護，PHY 被設到不存在的 rate

source 決定要訓練哪個 rate，依據是 EDID HF-VSDB 裡 sink 自己宣告的 Max_FRL_Rate。守規矩的 source 會照表操課；但交叉測試就是會遇到不守規矩或 buggy 的 source，直接把一個大於宣告值的 rate 寫進 0x31。sink 韌體如果對 0x31 的寫入照單全收，PHY 就會被設定到一個硬體根本不支援的 rate，下場就是黑畫面，而且因為訓練流程已經被污染，重試也不見得救得回來。

防護的做法：EDID 解析出的 Max_FRL_Rate 存成全域變數，SCDC 0x31 的寫入 callback 逐筆交叉驗證。寫入值超標時，PHY 不要切到這個 rate。但也不能裝死不回：HDMI 2.1 規定 sink 在 source 寫 FRL_Rate 之後 10 ms 內，要寫好 Ln(x)_LTP_req 並 set FLT_update（PDF p.103）。比較合規的回法是把所有 active lane 的 LTP_req 寫成 0xF，請 source 換 rate；source 收到後會進 LTS:4 選更低的 rate 重訓（PDF p.98、p.102–103）。要誠實說一句：規格 1 版（2017）沒有明文規定 sink 遇到「超過 Max_FRL_Rate」的寫入要怎麼處理，上面的作法是依訓練流程推論的防禦式設計；2.1b 是否補充待查證。

### 坑二：沒有錯誤監控狀態機，雪花雜訊一路累積到 link 崩掉

FRL 模式下，sink 端的 Character Error Detection 計數器在 SCDC 0x50 到 0x5A：每個 lane 一組 15-bit 錯誤計數，高位元組的 bit7 是 Valid 旗標；0x56 是 checksum；Lane 3 在 0x57/0x58；Reed-Solomon correction 計數在 0x59/0x5A（HDMI 2.1 Table 10-24，PDF p.366；kernel `drm_scdc.h` 定義一致）。

規格（PDF p.366）和 kernel 的 `drm_scdc_parse_error_counters()` 都要求：3 lane（FRL_Rate ≤ 2）時 0x50–0x56 共 7 個位元組、4 lane（FRL_Rate ≥ 3）時 0x50–0x58 共 9 個位元組，一個位元組的總和必須為 0，否則整組計數不可信。也就是說你讀回來的錯誤計數自帶一個 checksum 驗證，不做這個檢查，你拿垃圾值去判斷 link 品質，降級決策就是亂槍打鳥。

另外 CHANNEL_VALID 沒 set 的 lane，計數視為 0，不要把高位元組的旗標 bit 當成數值的一部分拿去算。

這裡有兩個規格細節會直接打掛「讀 SCDC、算差值」的寫法：

1. **SCDC 計數器被 source 讀取就清零**（PDF p.365）。source 只要讀一次，sink 這邊算出來的差值就會變負數或亂跳。所以 sink 韌體要讀 PHY 內部的累計計數（是否不受 source 讀取影響，依晶片而定，待查證），不要拿 SCDC 0x50–0x5A 當自己的資料來源。而且 0x50–0x5A 本來就是 sink 自己的暫存器，韌體不必、也不該透過 I2C 去讀。
2. **門檻規格有給**：任一 lane 的錯誤計數一秒內增加超過 4，或計數到頂，sink 必須 set CED_Update；RS 修正計數同理 set RSED_Update（PDF p.366）。這是「通知 source」的最低要求。

要不要進一步重新訓練，才是設計選擇：在 LTS:P 狀態，sink set FLT_update 就會讓雙方回到 LTS:3 重新訓練（PDF p.104）。責任歸屬：FLT_update 是 sink set、source 讀完寫 1 清除，sink 不自行 clear（PDF p.102–104）。

回到 LTS:3 之後的順序，我建議先調 FFE 再換 rate（個人經驗推論）：先用 0xE 請 source 把 TxFFE 提高一級（每次請求只升一級，TxFFE0→1→2→3，前提是 source 的 FFE_Levels 不為 0；換 rate 時 TxFFE 會重置回 TxFFE0，PDF p.105–106），不夠再用 0xF 請 source 換到較低的 rate。換 rate 意味著頻寬變小，可能要動 DSC 或解析度策略，是最後手段。

### 坑三：斷線重連的狀態生命週期沒人管

kernel `drm_scdc_helper.c` 的文件註解有一段話值得每個 sink 韌體工程師背下來：SCDC 的狀態在顯示器斷線時會遺失，斷線不只是拔線，還包括螢幕開關機這種情況；而且斷線重連後 KMS 不會自己換 mode，得靠追蹤 connector 狀態變化去還原 SCDC 狀態，kernel 舉的例子是 vc4 的 `vc4_hdmi_reset_link()`。

對應到 sink 端就是鏡像問題。規格要求：HPD 拉低 100 ms 以上、或 source 的 +5V 消失時，sink 要清掉 Status Flags（PDF p.364）；但 Character Error Detection 計數器只在 +5V 消失時清，HPD 拉低時不應清（PDF p.365）。你這邊的狀態（Status Flags、舊的 FRL_Rate、TMDS_Config）如果沒照規則清，source 重連時會讀到 stale 狀態，等不到正確的 FLT_READY，訓練流程整個卡死，使用者看到的就是要拔插線才會活。

正確的生命週期是：HPD 低超過 100 ms 或 +5V 消失，就清 Status Flags 並重置狀態機（錯誤計數器依上面的規則處理）；準備好訓練時（LTS:2）set FLT_ready、回到等訓練的狀態（PDF p.101）。另外兩個 kernel 教我們的實務細節：讀整份 256-byte SCDC 狀態要分兩次 128-byte 讀，避開某些 DP 轉 HDMI 轉換器的問題；source 寫 TMDS_CONFIG 的 clock ratio 之後，spec 要求等最少 1 ms、最多 100 ms（kernel 註解引用 spec，kernel 自己只等最多 2 ms）。

把三個坑收斂成一個狀態機，核心程式如下。SCDC 的 offset 與 bit 定義對照 HDMI 2.1 規格頁碼（與 kernel 公開原始碼一致）；所有 scaler 內部介面（`scdc_local_*`、`phy_*`）都是示意：

```c
/* =====================================================================
 * scdc_fault_handler.c — HDMI 2.1 FRL rate guard + 錯誤監控（sink 端）
 * SCDC offset／bit：HDMI 2.1 §10.4（PDF p.356–366），與 kernel drm_scdc.h 一致
 * FRL 訓練狀態與 LTP_req 編碼：HDMI 2.1 §6.4.2（PDF p.97–106）
 * 注意：sink 是 SCDC 的 I2C slave，0x10–0x5A 是「自己的」暫存器，
 *       韌體直接改本地暫存器，不是透過 I2C 去讀寫。
 * ===================================================================== */
#include <stdint.h>

/* ---- 規格定義 ---- */
#define SCDC_FLT_UPDATE          (1u << 5)  /* 0x10；sink set，source 寫 1 清除 */
#define SCDC_FRL_START           (1u << 4)  /* 0x10；sink set，source 寫 1 清除 */
#define SCDC_CED_UPDATE          (1u << 0)  /* 0x10 */
#define SCDC_FRL_RATE_MASK       0x0Fu      /* 0x31 bit3..0 */
#define SCDC_FFE_LEVELS_MASK     0xF0u      /* 0x31 bit7..4 */
#define LTP_NONE                 0x0u       /* 全部 lane 寫 0＝訓練完成 */
#define LTP_FFE_UP               0xEu       /* 請 source 把該 lane TxFFE 提高一級 */
#define LTP_RATE_CHANGE          0xFu       /* 請 source 換 rate；所有 active lane 同時寫 */
#define CED_TRIP_PER_SEC         4u         /* 每秒增加超過 4 就要 set CED_Update（PDF p.366） */

/* ---- 示意：scaler 內部介面，非實際晶片規格 ---- */
extern void     scdc_local_set_ltp_req(uint8_t lane, uint8_t code);   /* 寫本地 0x41/0x42 */
extern void     scdc_local_set_update(uint8_t bits);                  /* 寫本地 0x10 */
extern uint8_t  scdc_local_update_pending(uint8_t bits);              /* source 清掉了沒 */
extern void     scdc_local_set_flt_ready(void);                       /* 本地 0x40 bit6 */
extern void     scdc_local_reset_status_flags(void);                  /* 只清 0x40–0x42 */
extern void     phy_frl_config(uint8_t rate);                         /* 0 = 關閉 */
extern uint8_t  phy_active_lanes(void);
extern uint32_t phy_err_count_raw(uint8_t lane);  /* PHY 內部累計值，不受 source 讀取清除（待查證：依晶片） */

static uint8_t  g_max_frl_rate;   /* EDID HF-VSDB Max_FRL_Rate，由 edid_parse_hf_vsdb() 填入 */
static uint32_t s_err_prev[4];

typedef enum {
    SCDC_FSM_IDLE = 0,      /* TMDS 或未連結 */
    SCDC_FSM_TRAINING,      /* LTS:3 */
    SCDC_FSM_ACTIVE         /* LTS:P，錯誤監控中 */
} scdc_fsm_state_t;
static scdc_fsm_state_t s_state = SCDC_FSM_IDLE;

static void ltp_all_lanes(uint8_t code)
{
    uint8_t n = phy_active_lanes();
    for (uint8_t i = 0; i < n; i++)
        scdc_local_set_ltp_req(i, code);
    scdc_local_set_update(SCDC_FLT_UPDATE);   /* 規格：寫 FRL_Rate 後 10 ms 內要回應（PDF p.103） */
}

/* 1. Rate guard：source 寫 0x31 時呼叫（I2C slave write callback） */
void scdc_on_frl_rate_write(uint8_t reg_val)
{
    uint8_t rate = reg_val & SCDC_FRL_RATE_MASK;

    if (rate == 0u) {                /* 回到 TMDS */
        phy_frl_config(0u);
        s_state = SCDC_FSM_IDLE;
        return;
    }
    s_state = SCDC_FSM_TRAINING;
    if (rate > g_max_frl_rate) {
        /* 超過 EDID 宣告：PHY 不切到這個 rate，改用 0xF 請 source 換 rate。
         * 規格沒有明文規定 sink 對超標寫入的處理，此為依 LTS:3／LTS:4 流程推論的作法。 */
        phy_frl_config(0u);
        ltp_all_lanes(LTP_RATE_CHANGE);
        return;
    }
    phy_frl_config(rate);
    /* 接著依 PHY 等化結果逐 lane 要求 LTP1–8 或 0xE；完成時全部寫 LTP_NONE（略） */
}

/* 2. 錯誤監控：約 1 秒呼叫一次。讀 PHY 內部累計值，不讀 SCDC 0x50–0x5A，
 *    因為 SCDC 計數器被 source 讀取就會清零（PDF p.365），差值會失真。 */
void scdc_error_monitor_tick(void)
{
    uint8_t n = phy_active_lanes();
    uint8_t trip = 0u;

    if (s_state != SCDC_FSM_ACTIVE)
        return;
    for (uint8_t i = 0; i < n && i < 4u; i++) {
        uint32_t cur = phy_err_count_raw(i);
        if ((uint32_t)(cur - s_err_prev[i]) > CED_TRIP_PER_SEC)
            trip = 1u;
        s_err_prev[i] = cur;
    }
    if (trip) {
        scdc_local_set_update(SCDC_CED_UPDATE);   /* 規格要求的通知（PDF p.366） */
        /* 要不要重新訓練是設計選擇：LTS:P 下 sink set FLT_update 即回到 LTS:3（PDF p.104），
         * 進 LTS:3 後先用 0xE 提高 TxFFE，不夠再用 0xF 換 rate。門檻需實測標定。 */
    }
}

/* 3. 訓練完成、收到 FRL 串流後：set FRL_start。FLT_ready 不清（PDF p.104、p.364） */
void scdc_on_frl_stream_detected(void)
{
    scdc_local_set_update(SCDC_FRL_START);
    s_state = SCDC_FSM_ACTIVE;
}

/* 4. HPD 低超過 100 ms 或 +5V 消失：清 Status Flags（PDF p.364）。
 *    Character Error Detection 計數器只在 +5V 消失時清，HPD 拉低時不應清（PDF p.365）。 */
void scdc_on_hpd_low_100ms(void)
{
    scdc_local_reset_status_flags();
    s_state = SCDC_FSM_IDLE;
}

void scdc_on_ready_for_training(void)   /* LTS:2／LTS:L：set FLT_ready（PDF p.101、p.105） */
{
    scdc_local_set_flt_ready();
}
```

已查證與示意的界線：0x10／0x31／0x40／0x41／0x42／0x50 至 0x5A 的 offset 與 bit、FRL rate 編碼、LTP_req 編碼、計數器 clear-on-read、checksum 規則、CED_Update 的「一秒增加超過 4」、FLT_update／FRL_start 的責任，都已對照 HDMI 2.1（2017）規格頁碼；SCDC slave address 0x54、128-byte 分段讀取、TMDS config 寫入後等 1 至 100 ms 出自 Linux kernel 公開原始碼與文件。所有 `scdc_local_*`、`phy_*` 介面、重新訓練的門檻與時機都是示意或設計選擇，要對照手上 scaler 的 NDA 文件與實測標定。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

DVT 階段，一台 4K120 螢幕，HDMI 2.1 input，實驗室交叉測試三個情境：

第一個是客訴（情境模擬）裡最難查的那種：「看影片看到一半畫面壞掉」。某 GPU 平台 A 以 FRL 6 Gbit/s × 4 lanes 訓練成功，畫面正常好幾分鐘，然後雪花狀雜訊，再幾秒黑畫面，source 重訓練才恢復。量測現象：logic analyzer 上 SCDC 0x50 開始的錯誤計數在雜訊出現前就一路爬升，但 sink 韌體完全沒有讀它。協定層分析：character error 累積超過 Reed-Solomon 能修的量，link 品質劣化到崩潰。根因就是坑二，沒有監控、沒有門檻、沒有降級路徑。

第二個是一插上就黑畫面。某 GPU 平台 B 插上後直接黑，logic analyzer 量 DDC 發現 source 寫進 SCDC 0x31 的 FRL_RATE 值大於 EDID HF-VSDB 宣告的 Max_FRL_Rate，sink 韌體沒檢查，PHY 直接被設定到不存在的 rate。根因是坑一，rate guard 整個缺位。

第三個是斷電重連後連不上。螢幕關機再開機，source 讀 SCDC 讀到殘留的舊狀態，等不到 FLT_READY，連結建不起來，要拔插線才恢復。根因是坑三，SCDC 狀態生命週期沒人管，kernel 文件那句「斷線即遺失」在 sink 端同樣成立。

三個症狀、三個根因，但結構性缺口只有一個：把訓練成功當終點。訓練成功只是儀表板開始工作的那一刻，不是可以轉身離開的那一刻。

## 新人避坑指南

先學會看儀表板。SCDC 0x40 是狀態旗標：bit0 Clock_Detected、bit1 到 bit4 是各 channel／lane lock、bit6 FLT_ready、bit7 DSC_DecodeFail（HDMI 2.1 Table 10-23，PDF p.364；kernel `drm_scdc.h` 定義一致）。0x50 到 0x5A 是錯誤計數區。客退（RMA）分析的第一步，就是把這兩區的快照 dump 下來：是錯誤累積（坑二）、訓練參數問題（坑一）、還是狀態殘留（坑三），一眼可辨。

寫 code 與驗證時的檢查清單：

- EDID HF-VSDB 的 Max_FRL_Rate 解析結果存成全域，0x31 寫入 callback 逐筆交叉驗證；寫入值 0 要能乾淨退回 TMDS。
- SCDC 錯誤計數器會被 source 讀取清零；sink 自己的監控讀 PHY 內部累計值。Valid 沒 set 的 lane 計數視為 0。
- 任一 lane 一秒增加超過 4 就 set CED_Update（規格要求）。
- FLT_update、FRL_start：sink set、source 寫 1 清除，sink 不自行 clear。FLT_ready 只在無法做 FRL 時才清。
- source 寫 FRL_Rate 後 10 ms 內要寫好 LTP_req 並 set FLT_update；超標 rate 用 0xF 回應，不要裝死。
- HPD 低超過 100 ms：清 Status Flags；錯誤計數器只在 +5V 消失時清。
- SCDC 的 I2C 讀取失敗（bus 忙碌、HDCP 佔用 DDC）時，監控任務要容忍，不得誤判成 link 錯誤。
- 認證前用訊號產生器降低訊號品質、加長線材注入錯誤，驗證降級路徑真的會走，而不是只在訊號完美的實驗室裡全綠。
- 錯誤門檻與降級順序實測標定，並和 PHY 團隊確認 PHY 在訓練中途換 rate 的能力。

最後提醒：本篇協定細節已對照 HDMI Specification 2.1（2017-11-13）原文頁碼，並與 kernel 原始碼交叉確認；2.1a／2.1b 的增修本篇未核對（待查證），實作時請以你手上最新版 Adopter 文件為準。

## 思考題

sink 在 LTS:3 把某兩條 lane 的 LTP_req 寫成 0xE、另外兩條寫成 0x5，source 會怎麼做？如果 sink 想換 rate，卻只把其中一條 lane 寫成 0xF，會發生什麼事？提示：對照 HDMI 2.1 Table 6-32（PDF p.98）與 LTS:3 的 source 流程（PDF p.102），並想想 tFLT（每個 rate 最多 200 ms，PDF p.97）到期時 source 會退到哪個狀態。

## 參考資料

- Linux kernel，`include/drm/display/drm_scdc.h`（官方上游原始碼）：SCDC 暫存器 offset 與 bit 定義、error counter 結構。https://raw.githubusercontent.com/torvalds/linux/master/include/drm/display/drm_scdc.h
- Linux kernel，`include/drm/display/drm_scdc_helper.h`（官方上游原始碼）：`enum drm_scdc_frl_rate`（FRL rate 編碼 0 至 6、7 至 15 保留）、`drm_scdc_num_frl_lanes()`。https://raw.githubusercontent.com/torvalds/linux/master/include/drm/display/drm_scdc_helper.h
- Linux kernel，`drivers/gpu/drm/display/drm_scdc_helper.c`（官方上游原始碼）：SCDC slave address 0x54、斷線狀態遺失與 vc4 還原範例、error counter checksum 檢查、128-byte 分段讀取、TMDS config 寫入後等 1 至 100 ms。https://raw.githubusercontent.com/torvalds/linux/master/drivers/gpu/drm/display/drm_scdc_helper.c
- Linux kernel GPU 文件「Mode Setting Helper Functions」SCDC Helper 章節（官方文件）：SCDC 為 HDMI 2.0 引入、與 EDID 共用 I2C、TMDS clock ratio 1/10 與 1/40。https://www.kernel.org/doc/html/latest/gpu/drm-kms-helpers.html
- Texas Instruments，Precision Labs「Overview of DDC bus in HDMI systems」簡報（官方教育材料）：FRL rate/lane 對照、Status Flag 與 Update Flag 各 bit、LTP_REQ 語意、source 等 FLT_READY、sink 訓練成功 clear FLT_READY 並 set FRL_START。https://www.ti.com/content/dam/videos/external-videos/en-us/11/3816841626001/overview-ddc-bus-hdmi-systems.mp4/subassets/overview-ddc-bus-hdmi-systems-presentation.pdf
- HDMI LA，「The HDMI Forum Releases Version 2.1b of the HDMI Specification」（2023-08-10，官方公告）：2.1b 為清理、互通性澄清與 errata 整合版，全文需 Adopter 身分。https://www.hdmi.org/announce/detail/159
- HDMI Forum，HDMI Specification Version 2.1（2017-11-13，Adopter 文件，本文只引用頁碼並改寫）：tFLT 200 ms（PDF p.97）、LTP 編碼 Table 6-32（PDF p.98）、LTS 狀態表（PDF p.101–105）、TxFFE 調整（PDF p.105–106）、Max_FRL_Rate（PDF p.347）、FRL_Rate 編碼（PDF p.361）、Status Flags（PDF p.364–365）、Character Error Detection（PDF p.365–366）。
- Intel，Stratix 10 HDMI IP Design Example User Guide（PDF 683701）：source 端 200 ms timer、Clear Sink FLT_Update 由 source 執行；與 HDMI 2.1 規格一致（本環境抓取 Intel 文件被拒，HTTP 403）。
