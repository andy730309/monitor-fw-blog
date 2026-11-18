---
layout: post
title: "EDID checksum 錯位與 HPD toggle：當動態 EDID 遇上 DisplayID re-read"
date: 2026-11-18
tags: [EDID, HPD, DisplayID, checksum, DP CTS]
level: advanced
prerequisites: ["從零成為顯示器架構師：EDID 入門與 edid-decode 實作", "從零成為顯示器架構師：DDC/CI 與 ddcutil 實作"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: senior
sources_checked: 2026-11-18
difficulty: advanced
---
## 前置知識

EDID (Extended Display Identification Data) 是顯示器對 source 宣告能力的標準方式。每個 128-byte block 都有一個 checksum (byte 127，位址 0x7F)，其規則是：所有 128 個 byte 當作無號整數相加，mod 256 的結果必須等於 0。任何 block mutation（改 extension count、改 SVD、改 timing）必須同步重算 checksum，否則 source 會判定 EDID 無效。之後用什麼解析度由 source 決定：DP 2.0 規定 EDID 損壞時，source 可改用自選的 fallback timing（VESA DP 2.0 PDF p.987）；Linux 在 base block 無效時直接當作沒有 EDID（drivers/gpu/drm/drm_edid.c）。Windows 實際會落到哪個解析度，待查證。

DisplayID 是 VESA 為了取代/補充 EDID 而設計的模組化資料結構。DisplayID section 也有自己的 checksum (section 最後一個 byte)，規則是：section 內所有 byte (含 checksum) mod 256 == 0。當 DisplayID 封裝在 CTA-861 extension block 時，還有 outer 層的 EDID extension block checksum (128-byte block 的 byte 127) 同時存在。任一層錯誤，Linux 都會棄用整個 DisplayID extension：外層 checksum 錯，這個 block 在讀取時就被濾掉（drm_edid.c `edid_filter_invalid_blocks`）；內層 section checksum 錯，`validate_displayid` 回 `ERR_PTR(-EINVAL)`（drivers/gpu/drm/drm_displayid.c）。結果都是高刷新 timing 瞬間消失。

## 技術核心

### 症狀複盤

某機種在 DVT 階段做「動態 EDID」功能：依據輸入源與韌體版本，把 Base Block byte 126 (extension count) 與 CTA-861 extension 的 SVD 清單改寫，並在 DisplayID 2.x extension 裡追加 4K144 timing。測試時出現三種症狀：

1. 換線或重新開機後，Windows 顯示「Generic Non-PnP Monitor」，解析度鎖在 640×480@60，OSD 裡的 4K144 選項消失。
2. 接 DP 參考 source 做 `TEST_EDID_READ` 時，source 寫進 DPCD 0x261 的 checksum（它讀到的最後一個 EDID block 的 checksum）跟新版 EDID 對不上，代表 source 讀到的是舊 EDID。注意方向：這個測試是 sink 端設請求旗標，由 source 讀 EDID、寫 checksum（VESA DP 2.0 PDF p.496、p.505）。
3. Linux 主機 `dmesg` 出現 `DisplayID checksum invalid, remainder is N`，高刷新 timing 全部被忽略，但 4K60 仍可用。

### 根因分析

**1. EDID Base Block checksum (byte 127)**

- Base Block 128 bytes，byte 126 = extension count，byte 127 = checksum。
- 契約：128 個 byte 的無號總和 mod 256 == 0（Linux kernel `edid_block_compute_checksum`：`crc = 0x100 - sum(block[0..126])`）。
- 任何 mutation 都必須重算 byte 127。只改 byte 126 而不重算 byte 127，host 的 `edid_block_check` 會回 `EDID_BLOCK_CHECKSUM`，base block 被判定無效 → host 退回 640×480 fallback。

**2. Extension block checksum (CTA-861)**

- 每個 CTA-861 extension block 也有自己的 checksum (最後一個 byte)。
- Linux kernel 對 CTA-861 extension 的壞 checksum 是「忽略 checksum 錯誤、保留這個 block」：`edid_block_status_valid` 把 `EDID_BLOCK_CHECKSUM && tag == CEA_EXT` 當成有效，dmesg 印「checksum is invalid … ignoring」（drm_edid.c）。所以在 Linux 上，CTA-861 壞 checksum 不會讓 timing／audio 消失，問題反而被藏起來；其他 source（Windows、TV box、KVM）怎麼處理，待查證。不要拿 Linux 正常當成 checksum 沒問題的證據。

**3. DisplayID section checksum (tag 0x70)**

- DisplayID extension 有**兩層** checksum：外層 128-byte block checksum (byte 127) + 內層每個 DisplayID section 的 checksum (section 最後一個 byte，section 內所有 byte 總和 mod 256 == 0)。
- 任一層壞掉，整個 DisplayID extension 都會被丟棄 → 高刷新 timing 消失。外層錯：tag 0x70 不在 kernel 容忍的範圍，block 被濾掉；內層錯：`validate_displayid` 回 `ERR_PTR(-EINVAL)`。只有命中 kernel quirk 表 `QUIRK_IGNORE_CHECKSUM` 的機種例外。

**4. Host 不會主動重新讀取 EDID，必須由 sink 用 HPD toggle 通知**

- HDMI 規格寫 source「可以」用 HPD 高電位啟動 EDID 讀取，並要求 sink 改了 E-EDID 就要送一個至少 100 ms 的低電位脈衝通知（HDMI 1.4 PDF p.168 §8.5）。DP 是 source 在 HPD 變成 active 後讀 EDID（DP 2.0 PDF p.987），低於 2 ms 的脈衝是 IRQ_HPD，超過 2 ms 才算 hot plug（DP 2.0 PDF p.65）。
- 規格沒有保證 source 會自己重讀，實務上多數 source 只在 HPD 變化後重讀。因此 sink 即使把 EDID 改對了，若不 toggle HPD（先拉低、等 host 偵測到 disconnect、再拉高），host 很可能一直用快取的舊 EDID。

### 韌體修正原始碼 (示意)

以下程式碼段說明核心邏輯，暫存器地址、GPIO 與 API 為示意，非實際晶片規格。DisplayID section 位置依 kernel `find_next_displayid_extension`：section 從 extension block 的 byte 1 開始，長度＝4 byte header＋payload bytes＋1 byte checksum。

DP 的 `TEST_EDID_READ`（DPCD 0x201 bit1、0x218 bit2、0x260 bit2、0x261）是 source 端的工作：sink 設請求旗標，source 讀 EDID 後把最後一個 block 的 checksum 寫進 0x261（VESA DP 2.0 PDF p.489、p.496、p.505；Linux i915 `intel_dp_autotest_edid`）。螢幕韌體不用、也不該自己寫 0x261，所以這裡不放那段程式；sink 端要做的，就是讓每一個 block 的 checksum 正確。

```c
/* 示意地址與 API，非實際晶片規格 */
#define EDID_BLOCK_SIZE    128
#define EDID_EXT_DISPLAYID 0x70     /* EDID extension tag：DisplayID */
#define HPD_GPIO           3        /* 示意 GPIO 編號 */
#define HPD_LOW_MS         100u     /* HDMI：至少 100 ms（HDMI 1.4 PDF p.168 §8.5）；DP 見正文 */

/* 1. 單一 128-byte block 的 checksum：回傳應寫入 byte 127 的值 */
static uint8_t edid_block_checksum(const uint8_t *blk)
{
    uint8_t sum = 0;                  /* uint8_t 自動 mod 256 */
    uint8_t i;
    for (i = 0; i < EDID_BLOCK_SIZE - 1; i++)
        sum += blk[i];
    return (uint8_t)(0x100 - sum);
}

/* 2. DisplayID section checksum：len 含 checksum byte，但加總時不算它 */
static uint8_t displayid_section_checksum(const uint8_t *sec, uint16_t len)
{
    uint8_t sum = 0;
    uint16_t i;
    for (i = 0; i + 1 < len; i++)     /* 只加到 checksum 之前 */
        sum += sec[i];
    return (uint8_t)(0x100 - sum);
}

/* 3. 改完內容後，由內而外重算：DisplayID section → 128-byte block */
static bool edid_fix_checksums(uint8_t *edid, uint8_t num_blocks)
{
    uint8_t i;
    if (num_blocks == 0)
        return false;
    edid[126] = (uint8_t)(num_blocks - 1);          /* extension count */
    for (i = 0; i < num_blocks; i++) {
        uint8_t *blk = edid + (uint16_t)i * EDID_BLOCK_SIZE;
        if (i > 0 && blk[0] == EDID_EXT_DISPLAYID) {
            uint8_t *sec = blk + 1;                 /* section 從 byte 1 開始 */
            uint16_t len = 4u + sec[1] + 1u;        /* header 4 + payload + checksum */
            if (1u + len > EDID_BLOCK_SIZE - 1u)
                return false;                       /* section 超出 block，不 commit */
            sec[len - 1] = displayid_section_checksum(sec, len);
        }
        blk[EDID_BLOCK_SIZE - 1] = edid_block_checksum(blk);   /* 外層最後算 */
    }
    return true;
}

/* 4. 單一 commit 出口：重算 → 拉低 HPD → 更新 shadow → 拉高 HPD */
static bool edid_commit(uint8_t *new_edid, uint8_t num_blocks)
{
    if (!edid_fix_checksums(new_edid, num_blocks))
        return false;

    gpio_set(HPD_GPIO, 0);           /* 先拉低：HPD 為 high 時 EDID 必須隨時可讀 */
    edid_shadow_write(new_edid, (uint16_t)num_blocks * EDID_BLOCK_SIZE);  /* 示意 API */
    delay_ms(HPD_LOW_MS);            /* 低電位總時間 ≥ HPD_LOW_MS */
    gpio_set(HPD_GPIO, 1);           /* 拉高：source 依 HPD 重新讀 EDID */
    return true;
}
```

`HPD_LOW_MS` 依介面設定：HDMI 至少 100 ms（HDMI 1.4 PDF p.168）；DP 上 sink 自己產生的拔插脈衝，規格描述為通常大於 2 ms、小於 100 ms，並提醒 source 不要對這種脈衝做 100 ms debounce（DP 2.0 PDF p.719）。DP 實際取多長，要和目標 source 實測，待查證。

## 真實血淚案例

> **情境模擬（依公開規格推演），非真實客戶或產品事件。**
>
> 系統廠在 DVT 階段收到客戶投訴：換線後螢幕顯示「Generic Non-PnP Monitor」，解析度被鎖在 640×480@60，原本設好的 4K144 選項全部消失。經過一週的排查，發現問題出在動態 EDID 變更流程上。
>
> 量測發現：I2C analyzer 顯示，當韌體更新 EDID 內容後，HPD 線維持高電位不變，主機根本沒有重新讀取 EDID。更可怕的是，當 DisplayID section 的 checksum 計算錯誤時，Linux kernel 直接丟棄整個 DisplayID extension，導致 4K144 timing 瞬間消失，只剩下 4K60。
>
> 這個案例顯示了三個層級的失效：(1) checksum 沒重算 → EDID 無效，(2) HPD 沒 toggle → host 快取舊 EDID，(3) DisplayID section checksum 錯誤 → 高刷 timing 消失。三者皆必須同時正確，才能確保使用者看到正確的高解析度畫面。

## 新人避坑指南

1. **永遠在 commit 出口同時進行三件事**：(a) 重算 Base Block checksum (byte 127)，(b) 先重算 DisplayID section checksum，再重算所有 extension block checksum，(c) 先拉低 HPD，在低電位期間更新 EDID，再拉高。HDMI 低電位至少 100 ms（HDMI 1.4 PDF p.168）；DP 見上文（DP 2.0 PDF p.719）。HPD 為高電位時 EDID 必須隨時可讀（HDMI 1.4 PDF p.168），所以不能在 HPD 高電位時改 shadow。三者任何一項漏掉，都可能導致使用者看到畫面異常。
2. **DisplayID section checksum 別忘了**：如果你的 EDID 內含 DisplayID extension，記得同時檢查兩層 checksum：(1) DisplayID section 最後一個 byte，確保 section 內所有 byte mod 256 == 0；(2) EDID extension block byte 127，確保整個 128-byte block mod 256 == 0。兩者都是必須的，任一錯誤都會導致 driver 棄用該 extension。
3. **Extension Count byte 要對**：Base Block byte 126 必須等於實際掛載的 EDID extension block 數量。DisplayID section header 的 byte 3 是另一回事：kernel 結構 `struct displayid_header` 把它定義為 `ext_count`，指的是 DisplayID 自己的延伸 section 數量，不是 EDID extension block 數量（CTA-861 block 不算在內）。確切定義請對照 DisplayID 規格，待查證。
4. **HPD 脈衝寬度**：HDMI 規定 EDID 變更的低電位脈衝至少 100 ms（HDMI 1.4 PDF p.168 §8.5）。DP 不同：低於 2 ms 會被當成 IRQ_HPD（DP 2.0 PDF p.65），sink 產生的拔插脈衝通常是 2–100 ms（DP 2.0 PDF p.719）。HDMI 是否要留 150 ms 這類餘裕，屬經驗值，待查證。

## 思考題

請新人嘗試計算一個情境：已知一份 128-byte EDID Base Block，bytes 0~126 的無號總和為 0xA3。請問 byte 127 (checksum) 應該寫入什麼值？若同時也有 CTA-861 extension block (128 bytes)，其最後一個 byte (checksum) 應該如何計算？請自行驗證答案是否正確。

<details>
<summary>點此查看參考答案</summary>

EDID Base Block checksum：`(0x100 - 0xA3) & 0xFF = 0x5D`。

CTA-861 extension block checksum：同樣的公式，`(0x100 - (sum of bytes 0~126 of that extension)) & 0xFF`。因為每個 128-byte block 獨立計算 checksum，extension block 的 checksum 獨立於 Base Block 之外。

</details>

## 參考資料

1. **VESA Enhanced EDID Standard** - EDID Base Block checksum 規定：byte 7Fh (127) 應使 128-byte block 總和 mod 256 == 0。公式：`checksum = (−Σ block[0…126]) & FFh`。【VESA E-EDID Standard A.2；章節與表號未對照原文，待查證】

2. **VESA DisplayID Standard Version 2.0** - DisplayID section checksum 規定：section 最後一個 byte 使 section 內所有 byte mod 256 == 0。當 DisplayID 封裝在 EDID extension 時，還有 outer EDID extension block checksum (byte 127 of 128-byte block)。【VESA DisplayID v2.0；章節與表號未對照原文，待查證】

3. **VESA DisplayID v2.0 Errata E9 (Published 10/7/21)** - section bytes 欄位應設為 79h (121)，對應 framework 5 bytes + EDID extension tag + EDID block checksum = 128 bytes 總區塊。EDID extension block checksum 只需考慮 block tag byte (不需要重算 whole section checksum，因為 section checksum 已確保內部總和 0)。【VESA Standards Change Request Form，Errata E9；未取得原文，待查證。此算法只在 section 剛好填滿 block（bytes＝79h）時成立】

4. **HDMI Specification Version 1.4, Section 8.5（本機為 1.4，非 1.4b；PDF p.168）** - HPD 規定：E-EDID 不可讀時，Sink 不得把 HPD 拉高。Sink 應以至少 100 ms 的 low voltage pulse 指示 E-EDID 變更。Source 使用 high HPD 訊號啟動 EDID read。【HDMI 1.4 PDF p.168】

5. **Linux kernel drm/edid.c** - `edid_block_compute_checksum`：Base Block 128 bytes 無號總和 mod 256 == 0。公式：`crc = 0x100 - sum(block[0..126])`。【Linux kernel，drivers/gpu/drm/drm_edid.c，https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/drm_edid.c】

6. **VESA DP 2.0 DPCD 定義與 Linux i915 `intel_dp_autotest_edid`** - TEST_EDID_READ 流程：sink 設 DPCD 0x201 bit1（AUTOMATED_TEST_REQUEST）與 0x218 bit2（TEST_EDID_READ）；source 讀 EDID 後，把最後一個 block 的 checksum 寫進 0x261，並設 0x260 bit2（TEST_EDID_CHECKSUM_WRITE）。【VESA DP 2.0 PDF p.489、p.496、p.505；drivers/gpu/drm/i915/display/intel_dp_test.c，https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/i915/display/intel_dp_test.c】

7. **Linux kernel drm_displayid.c** - `validate_displayid`：DisplayID section checksum 驗證。若 checksum 不通，回 `ERR_PTR(-EINVAL)` 並丟棄整個 DisplayID extension，導致高刷新 timing 消失。【Linux kernel，drivers/gpu/drm/drm_displayid.c，https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/drm_displayid.c】

8. **Linux kernel patch** - `hdmi_hpd_debounce_work`：amdgpu 在 HDMI 斷線後延遲 1500 ms 再重新偵測，EDID 不變就當作螢幕自己產生的 HPD toggle，不送 hotplug 事件；EDID 變了才照常處理。2026 年 1 月的後續 patch 改成預設關閉，改由 `hdmi_hpd_debounce_delay_ms` 參數開啟（上限 5000 ms）。【amd-gfx 郵件列表，https://lists.freedesktop.org/archives/amd-gfx/2025-November/133763.html、https://lists.freedesktop.org/archives/amd-gfx/2026-January/136589.html】

9. **HDFury Dr HDMI knowledge base** - HPD technical 解析：HPD pin 19 電壓上升源偵測到 display 連接，EDID read 發生在 HPD high 期間。EDID 變更時必須先 HPD low→high 觸發 source re-read。【Dr HDMI，drhdmi.eu/hpd.html】

---
*本文依 rules/ARTICLE-SPEC.md 章節規範撰寫。已對照的規格標 PDF 頁碼；未完整驗證的條目標「待查證」，請實驗室實測確認。*
