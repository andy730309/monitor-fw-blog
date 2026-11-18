---
layout: post
title: "FW Release Management、Versioning 與 Rollback：版本號契約與 A/B 雙 bank"
date: 2026-11-17
tags: [firmware-release, versioning, rollback, dual-bank, MCUboot, SemVer, NIST-SP-800-193]
level: advanced
prerequisites: ["posts/2026-11-04-monitor-npi-gate-criteria-evt-dvt-pvt-mp.md"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: principal
sources_checked: 2026-11-17
difficulty: advanced
---
## 前置知識

想像你管理一個倉庫，每次進新貨都直接把舊貨丟掉、把新貨放上去，沒有備份、沒有標籤。一旦新貨有問題，你既不知道上一批是什麼，也拿不回上一批。顯示器韌體的 release 管理就是這個倉庫的管理規則：版本號是標籤、A/B bank 是備份、rollback 是拿回上一批的機制。

本篇核心規格有三份公開文件。第一份是 Semantic Versioning 2.0.0（semver.org），定義 `MAJOR.MINOR.PATCH` 的比較規則與「一旦釋出內容 MUST NOT 被修改」的契約。第二份是 NIST SP 800-193（Platform Firmware Resiliency Guidelines，2018 年 5 月），把韌體韌性拆成 protect / detect / recover 三層。第三份是 MCUboot 的設計文件（docs.mcuboot.com），說明 A/B slot 的 test swap / perm swap / revert 機制與 security counter（`IMAGE_TLV_SEC_CNT`，值 0x50）。

英文術語第一次出現時的對應：firmware（韌體）、rollback（回復）、dual-bank（雙 bank）、security counter（安全計數器）、release manifest（釋出清單）。

## 技術核心

### 版本號契約：SemVer 2.0.0

SemVer 規定版本號 MUST 採 `MAJOR.MINOR.PATCH`，且一旦釋出內容 MUST NOT 被修改（§3）。MAJOR 變更代表不相容的 API 變更、MINOR 代表向後相容的新功能、PATCH 代表向後相容的 bug fix（§6–§8）。build metadata 用 `+` 附加、pre-release 用 `-` 附加，且 build metadata 不影響優先序（§10）。

在 monitor 場景下，「public API」應理解為 DDC/CI VCP 行為契約與 OSD 行為契約（個人經驗推論，待團隊定義）。例如：VCP 0x10 亮度的讀寫範圍、OSD 選單結構、Factory Mode 進入方式。這些一旦改變，MAJOR 就要遞增。

### Anti-rollback：security counter

NIST SP 800-193 把韌體韌性拆成 protect / detect / recover 三層，其中 recover 要求能從攻擊或損毀中快速安全地回復。若只靠 image OK 旗標，攻擊者可以灌回舊版有漏洞的 image。MCUboot 用 `IMAGE_TLV_SEC_CNT`（security counter，TLV type 0x50）讓 bootloader 拒絕版本低於已記錄 security counter 的 image。monitor 場景下，已記錄的 security counter 不可回退；但「image 的 security counter 要不要每版都加」是取捨：每版都加，新版一旦 commit，就再也回不去上一版 release，和 release manifest 裡的 `rollback_to` 互相矛盾。比較實際的做法是只在需要封鎖舊版（例如修掉安全漏洞）時才加（設計取捨，個人經驗推論）。

### A/B dual-bank 與 revert

MCUboot 的 swap-based 升級需要 primary/secondary 兩個 slot。新 image 先寫入 secondary，bootloader 以 test swap 啟動新 image；新 image 必須在 self-test 通過後把 image OK 旗標寫成 0x01，否則下次開機 bootloader 會 revert 回舊 image（MCUboot design doc「Boot swap types」段）。swap type 包含 `BOOT_SWAP_TYPE_TEST`（試跑，未確認則 revert）、`BOOT_SWAP_TYPE_PERM`（永久）、`BOOT_SWAP_TYPE_REVERT`（回復舊版）。

### 更新狀態機

Linux kernel 的 Firmware Upload API 把更新拆成 prepare → write → poll_complete → cleanup，並用 progress code（`FW_UPLOAD_PROG_*`）與 error code（`FW_UPLOAD_ERR_*`）回報狀態（kernel docs `fw_upload.html`）。monitor 產線的 ISP 燒錄也應有等價的狀態機與錯誤碼，而不是「燒完重開看看」。

### 韌體修正原始碼

以下為示意程式碼，暫存器地址與 Macro 為示意，非實際晶片規格。

```c
/* 示意地址，非實際晶片規格 */
typedef struct {
    uint8_t  major;
    uint8_t  minor;
    uint16_t patch;
    uint32_t build;        /* build metadata，不參與相容性比較 */
    uint32_t security_cnt; /* anti-rollback counter，單調遞增 */
} fw_version_t;

static int fw_version_cmp(const fw_version_t *a, const fw_version_t *b)
{
    if (a->major != b->major) return (int)a->major - (int)b->major;
    if (a->minor != b->minor) return (int)a->minor - (int)b->minor;
    if (a->patch != b->patch) return (int)a->patch - (int)b->patch;
    return 0; /* build metadata 忽略（SemVer §10） */
}

static int rollback_allowed(const fw_version_t *new_img, uint32_t stored_sec_cnt)
{
    return new_img->security_cnt >= stored_sec_cnt;
}
```

```c
/* 示意地址，非實際晶片規格 */
#define BANK_A_BASE   0x08020000u  /* 示意地址，非實際晶片規格 */
#define BANK_B_BASE   0x080A0000u  /* 示意地址，非實際晶片規格 */

/* 示意結構與流程，非實際晶片規格 */
typedef enum { IMG_EMPTY = 0, IMG_TRIAL, IMG_CONFIRMED, IMG_BAD } img_state_t;

typedef struct {
    fw_version_t ver;
    img_state_t  state;        /* 存在 NVRAM，每個 bank 各一份 */
    uint8_t      sig_ok;       /* 簽章／hash 驗證結果 */
    uint8_t      trial_boots;  /* 試跑開機次數，跳轉前先寫回 NVRAM */
} bank_info_t;

extern void nvram_save_bank_info_with_crc(const bank_info_t bank[2],
                                          uint32_t stored_sec_cnt); /* 示意 */

static int bank_bootable(const bank_info_t *b, uint32_t stored_sec_cnt)
{
    return b->sig_ok &&
           (b->state == IMG_TRIAL || b->state == IMG_CONFIRMED) &&
           rollback_allowed(&b->ver, stored_sec_cnt);
}

/* 回傳 bank 編號；-1 表示兩個 bank 都不能開，進 recovery（例如 ISP／USB 更新模式） */
int boot_select_bank(bank_info_t bank[2], uint32_t stored_sec_cnt)
{
    int i, ok0, ok1;

    /* 試跑過一次仍沒有 commit：標記失敗，等於 revert 回另一個 bank */
    for (i = 0; i < 2; i++)
        if (bank[i].state == IMG_TRIAL && bank[i].trial_boots >= 1)
            bank[i].state = IMG_BAD;

    /* 第一次試跑的新 image 優先 */
    for (i = 0; i < 2; i++) {
        if (bank[i].state == IMG_TRIAL && bank_bootable(&bank[i], stored_sec_cnt)) {
            bank[i].trial_boots++;
            nvram_save_bank_info_with_crc(bank, stored_sec_cnt); /* 先存再跳，斷電也算一次 */
            return i;
        }
    }

    /* 其次：已確認的 image，兩個都可開就選版本較新的 */
    ok0 = bank[0].state == IMG_CONFIRMED && bank_bootable(&bank[0], stored_sec_cnt);
    ok1 = bank[1].state == IMG_CONFIRMED && bank_bootable(&bank[1], stored_sec_cnt);
    if (ok0 && ok1)
        return (fw_version_cmp(&bank[0].ver, &bank[1].ver) >= 0) ? 0 : 1;
    if (ok0) return 0;
    if (ok1) return 1;
    return -1;
}

/* self-test 通過後由新 image 呼叫 */
void fw_commit_ok(bank_info_t bank[2], int running, uint32_t *stored_sec_cnt)
{
    bank[running].state = IMG_CONFIRMED;
    if (bank[running].ver.security_cnt > *stored_sec_cnt)
        *stored_sec_cnt = bank[running].ver.security_cnt;  /* 只升不降 */
    nvram_save_bank_info_with_crc(bank, *stored_sec_cnt);
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 27 吋 4K 遊戲監視器機種進入 DVT 後期，韌體團隊準備把一版「修正 VRR flicker」的 build 交給工廠做 PVT 驗證。團隊過去的版本號寫法是 `V1.2`、`V1.2a`、`V1.2-final` 這類自由格式，flash 只有一個 bank，更新時直接覆寫。工廠燒錄新 build 後，約 3% 的 DUT 在開機時卡在 logo 畫面，無法進入 OSD；更糟的是，因為沒有 rollback 路徑，現場只能整機送回 RMA 重燒。客訴（Claim）與客退（RMA）同時爆量，NPI gate（EVT/DVT/PVT/MP）的 PVT exit criteria 也無法判定「這一版算不算通過」。

量測現象：bricked DUT 的 UART log 顯示 bootloader 跳轉到新 image 後在初始化 panel 時 hard fault；舊 image 已被覆寫，無法回復。協定層分析：問題不是協定層，而是 release 管理層——沒有版本契約（無法判定新舊）、沒有 A/B bank（無法 revert）、沒有 self-test gate（無法在 commit 前發現 fault）。

## 新人避坑指南

- 看懂關鍵暫存器/訊號線：NVRAM 中的 `security_cnt` 與「每個 bank 各自的狀態（試跑、已確認、失敗）」是 bootloader 決定啟動哪個 bank 的依據；flash 的 primary/secondary slot 是 A/B bank 的實體位置。bank 選擇要先看狀態，再看版本號，不能只比版本。
- 未來寫 Code 或驗證如何避免重蹈覆轍：
  1. 版本號一律採 `MAJOR.MINOR.PATCH`，build metadata 用 `+` 附加。
  2. 需要封鎖舊版時才遞增 image 的 `security_cnt`；bootloader 拒絕低於已記錄值的 image，已記錄值只升不降。
  3. Flash 採 A/B dual-bank；新 image 先寫 secondary，以 test swap 啟動，self-test 通過才 commit image OK。
  4. self-test 至少涵蓋：開機進 OSD、DDC/CI 0x10 亮度讀寫、主要 input port 顯示、無 crash 30 秒。
  5. Release manifest 綁定 version、security_cnt、fw_sha256、test_report、rollback_to；上傳 MES/traceability。

## 思考題

如果你的機種 flash 空間只夠一個 bank，無法做 A/B dual-bank，你會如何設計 rollback 機制？提示：思考 MCUboot 的 overwrite mode 與 external storage（如 SD card / USB）作為 secondary slot 的可行性，以及 self-test 失敗時的恢復路徑。答案請查 MCUboot design doc 的「Equal slots (direct-xip)」與「RAM loading」段。

## 參考資料

- NIST SP 800-193, Platform Firmware Resiliency Guidelines (May 2018) — https://csrc.nist.gov/pubs/sp/800/193/final ；PDF https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-193.pdf （官方）
- Semantic Versioning 2.0.0 — https://semver.org/ （官方規格）
- MCUboot design documentation — https://docs.mcuboot.com/design.html （開源專案文件）
- Linux kernel Firmware Upload API — https://www.kernel.org/doc/html/latest/driver-api/firmware/fw_upload.html （官方 kernel 文件）
- fwupd project README — https://github.com/fwupd/fwupd/blob/main/README.md （開源專案文件）
