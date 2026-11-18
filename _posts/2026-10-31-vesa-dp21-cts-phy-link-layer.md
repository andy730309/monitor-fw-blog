---
layout: post
title: "CTS 說你 UHBR10 沒過？128b/132b link training 的 CDS 階段與 DP 2.1 認證工具矩陣"
date: 2026-10-31
tags: [DisplayPort, DP 2.1, CTS, Link Training, 128b/132b, UHBR, DPCD, 認證]
level: intermediate
prerequisites: ["EDID 入門與 edid-decode", "DPCD 入門：Sink Capability 宣告", "DisplayPort link training 流程"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: senior
sources_checked: 2026-10-31
description: "UHBR10 過不了 CTS？解析 128b/132b link training 的 CDS 階段、DPCD 0x102 的雙重語意與認證工具。"
seo_title: "UHBR10 過不了 CTS？128b/132b 的 CDS 階段"
difficulty: intermediate
---
> **重點摘要**：能動不等於能過 CTS，認證儀器會逐條檢查 assertion。DPCD 0x102 寫入值 3 時，在 128b/132b 代表 TPS2_CDS，在 8b/10b 代表 TPS3，同一個值有兩種語意。訓練狀態機要依編碼模式分表，每宣告一個 capability 都要確認對應的 test case 過得了。

## 【前置知識準備】

先講三個名詞，用開車類比。

**Link training（連結訓練）**像兩台對講機開機後先校頻道：source（電腦）與 sink（螢幕）先講好要用多快的速度（link rate）、幾條車道（lane），再互相調整訊號品質直到聽得清楚。

**8b/10b vs 128b/132b**是兩種打包方式。8b/10b 每 8 bit 資料要帶 2 bit 的「包裝紙」，20% 頻寬被包裝吃掉；128b/132b 只吃 3%，所以同樣的線材能跑更快。DisplayPort 2.x 的 UHBR10/UHBR13.5/UHBR20（每 lane 10/13.5/20 Gbps）就是用 128b/132b。

**CTS（Compliance Test Specification，一致性測試規格）**是駕照考試的題本。平時開車（接真實 GPU 看影片）沒人管你轉彎有沒有打方向燈，但考照時考官（測試儀器）會逐條 assertion 檢查。「能動」跟「能過 CTS」是兩回事，這是新人最容易栽的第一個坑。

DP 2.1 認證的公開門檻（VESA compliance 頁明載）：最低 HBR2 + DSC，且至少支援 UHBR（128b/132b）、AdaptiveSync SDP、LTTPR、Panel Replay 四項之一。不是「掛 DP 2.1 字樣就能宣稱」，是要過測試、簽 Trademark License、列入 certified products list，三件事都做完才能用 logo。

## 【系統廠真實血淚案例】

情境模擬（依公開規格推演），非真實客戶或產品事件。

DVT 階段，4K144 UHBR10 機種在自家實驗室用 Unigraf UCD-500 Gen3（VESA 授權的 DP 2.1 reference sink/source）跑 Sink Link Layer CTS。HBR3 × 4 lane 全過，UHBR10 × 4 lane 的 Link Training test 直接 fail：reference source 送出 TEST_LINK_TRAINING（DPCD 0x218 bit0）後等不到 sink 回報完成，timeout。

第一反應是「儀器壞了吧，接真實 GPU 明明好好的」。錯。抓 AUX log 才看到：source 在 EQ 階段結束後把 TRAINING_PATTERN_SET（0x102）寫成 3，等的是 128b/132b 的 **CDS（Clock Data Switch）階段完成訊號**；我們的 sink FW 卻把值 3 當成 8b/10b 時代的 TPS3 在處理，CDS interlane align done（LANE_ALIGN_STATUS_UPDATED 0x204 bit3）永遠不會被置位，source 等到天荒地老。

協定層分析：128b/132b 的訓練流程是 TPS1（clock recovery）→ TPS2（EQ loop）→ TPS2_CDS。Linux kernel 的公開 DPCD 定義寫得很清楚：`DP_TRAINING_PATTERN_2_CDS = 3`（DP 2.0 E11 起），而且 0x204 的 bit2 是 EQ interlane align done、bit3 是 CDS interlane align done，兩個階段分開回報。我們的 FW 是從 DP 1.4 HBR3 版本改的，狀態機裡根本沒有 CDS 這個狀態。

第二個 fail 是 EDID Read test：sink 對 TEST_REQUEST（0x218）的 EDID read bit 回了 ACK，但忘了把 EDID checksum 寫進 TEST_EDID_CHECKSUM（0x261）並置 TEST_RESPONSE（0x260）的 TEST_EDID_CHECKSUM_WRITE（bit2）。source 拿不到 checksum 比對，照樣 fail。這種就是典型的「handler 寫一半」。

修正後的關鍵程式碼（DPCD 位址與位元出自 Linux kernel `drm_dp.h` 公開定義；Scaler 暫存器與 Macro 為示意）：

```c
/* 0x102 TRAINING_PATTERN_SET 被寫入時的 sink 端處理（示意架構） */
void dp_sink_on_training_pattern_set(u8 pattern)
{
    switch (pattern) {
    case DP_TRAINING_PATTERN_1:          /* 1 */
        s_lt_state = LT_EQ_PHASE;        /* 重置狀態機 */
        break;
    case DP_TRAINING_PATTERN_2:          /* 2：EQ phase */
        /* 等 0x204 bit2（EQ interlane align done） */
        break;
    case DP_TRAINING_PATTERN_2_CDS:      /* 3：128b/132b CDS（公開定義，2.0 E11） */
        /* 修正點：舊 FW 在這裡誤走 8b/10b TPS3 分支 */
        if (dp_sink_is_128b132b_mode()) {   /* 查 0x108 bit1（公開定義） */
            Scaler_Write_Register_Byte(REG_PHY_TPS_CTRL, 0x02 | PHY_TPS_CDS_EN);
            /* 示意地址，非實際晶片規格；CDS 完成後置 0x204 bit3 */
        } else {
            Scaler_Write_Register_Byte(REG_PHY_TPS_CTRL, 0x03); /* 示意 */
        }
        break;
    }
}

/* EDID read test：ACK 之外必須回寫 checksum（公開定義 0x260 bit2、0x261） */
if (test_req & DP_TEST_LINK_EDID_READ) {
    Scaler_Write_DPCD_Byte(0x00261, dp_sink_edid_checksum());
    resp |= DP_TEST_ACK | DP_TEST_EDID_CHECKSUM_WRITE;
}
```

還有一個觀念修正：0x2215（128b/132b supported link rates）宣告了 UHBR10，狀態機卻不支援 CDS，這叫「宣告了做不到」。CTS 的邏輯就是你宣告什麼就考什麼。TEST_LINK_TRAINING handler 後來加了自查：rate 沒在 0x2215 宣告過就回 NAK，不要硬接。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

- **DPCD 0x102（TRAINING_PATTERN_SET）**：source 寫入訓練圖樣。值 3 在 128b/132b 下是 TPS2_CDS，在 8b/10b 下是 TPS3。同一個值、兩種語意，這是整個 Bug 的核心。
- **DPCD 0x204（LANE_ALIGN_STATUS_UPDATED）**：bit2 = EQ interlane align done、bit3 = CDS interlane align done、bit4 = link training failed。sink 的「我好了」就是寫在這裡。
- **DPCD 0x108（MAIN_LINK_CHANNEL_CODING_SET）**：bit1 = 128b/132b。判斷值 3 該走哪個分支就看它。
- **DPCD 0x218/0x260/0x261**：compliance test 的請求（TEST_REQUEST）、回覆（TEST_RESPONSE）、EDID checksum（TEST_EDID_CHECKSUM）。CTS 的 sink 測試全都繞著這組暫存器轉。
- **訊號線層面**：這些互動全走 AUX channel，HPD 的 IRQ pulse（IRQ_HPD）是 test request 的敲門磚。AUX log 是除錯第一手證據。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- **capability 與狀態機一起 review**：每宣告一個 DPCD capability bit，就問一句「對應的 test case 我過得了嗎」。宣告表跟實作清單綁在同一份文件，改一邊必改另一邊。
- **訓練狀態機按編碼模式分表**：8b/10b 與 128b/132b 各一張狀態轉移表，不要共用一個 switch 讓值 3 兩種語意混在一起。
- **每個 test case 存 AUX trace**：CTS fail 的判讀靠 AUX log，不是靠「畫面有沒有出來」。log 要綁 build ID，送測版本要能回溯。
- **pre-compliance 先跑完再送測**：VESA 授權工具（UCD-500、M42de 等）在自家實驗室先跑一輪，fail 的 assertion 在內部修完，去測試中心一次過，省下重測的錢與時間。
- **PHY 與 Link Layer 分開排程**：PHY（電氣）測試要 BERT 與示波器（Keysight/R&S/Tek/LeCroy 的授權軟體），Link Layer 用 reference sink/source，設備與時間都不一樣，別混在一起估。

### 3. 思考題

DPCD 0x2216（128b/132b Training AUX RD Interval）讓 sink 宣告訓練期間 source 該多久讀一次狀態（400us 到 64ms 多檔）。問題：如果 sink 宣告了較長的 interval，CTS 對「整個 CDS 階段多久內要完成」的判定會不會跟著放寬？timeout 的門檻是固定值還是跟 interval 成比例？請去查 VESA DP 2.1 Link Layer CTS 原文（需會員權限，公司內部應有 NDA 文件）與 Linux kernel `drm_dp_128b132b_read_aux_rd_interval()` 的實作對照。

## 參考資料

1. VESA Compliance 官方頁（DP 2.1 認證門檻與 logo 流程）— 官方：https://compliance.vesa.org/home
2. VESA Authorized Test Tools（UCD-500/UCD-323、M42de/M42d、PHY 測試儀器授權清單）— 官方：https://vesa.org/authorized-test-tools/
3. DisplayPort 官方 FAQ（DP 2.1b、77.37 Gbps、128b/132b 3% overhead、認證不自動轉移）— 官方：https://www.displayport.org/faq/
4. Teledyne LeCroy quantumdata M42de 產品頁（UHBR lane rates、T.A.P.4 被動監控、LTTPR 一鍵測試、Python API）— 官方（廠商）：https://teledynelecroy.com/protocolanalyzer/quantumdata-m42de.aspx
5. Linux kernel `include/drm/display/drm_dp.h`（DPCD 0x006/0x102/0x108/0x204/0x218/0x260/0x261/0x2215/0x2216 公開定義）— 開源原始碼：https://raw.githubusercontent.com/torvalds/linux/master/include/drm/display/drm_dp.h
6. Linux kernel `include/drm/display/drm_dp_helper.h`（128b/132b 輔助函式）— 開源原始碼：https://raw.githubusercontent.com/torvalds/linux/master/include/drm/display/drm_dp_helper.h

> 注意：DP 2.1 Link Layer CTS 與 PHY CTS 規格全文需 VESA 會員權限；本文僅依公開資訊撰寫，實作與送測請對照手上的 NDA 文件與 CTS 版本。
