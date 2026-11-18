---
layout: post
title: "OTA 斷電變磚？顯示器韌體的 SPI flash dual-bank 與防斷電更新"
date: 2026-11-04
tags: [SPI flash, dual-bank, OTA, bootloader]
level: intermediate
prerequisites: ["Scaler FW 架構（MCU core、ISR、task loop/RTOS）通論", "SPI flash 基本讀寫概念"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
difficulty: intermediate
---
## 前置知識

顯示器的韌體（firmware）通常燒在一顆 SPI flash 裡，這顆 flash 同時放著 scaler FW 映像、OSD 字型、圖示與 menu table。新手常以為「把新韌體寫進 flash 就完成升級」，但實際上升級期間若斷電，舊映像可能已被擦除、新映像又寫不完，結果是開機黑畫面、OSD 不出現、輸入源切換失效，只能回廠透過 ISP 重燒。

這篇要講的是 dual-bank（A/B bank）機制：flash 被切成兩個獨立的 bank，升級時只寫「沒在用」的那一個，驗證通過後再切換啟動 bank。這樣即使升級中斷斷電，舊 bank 還在，機器仍能開機。相關概念可參考 U-Boot 的 partitions 與 boot count 機制（公開文件，見參考資料）。

## 技術核心

### 問題：單 bank 就地升級的斷電風險

傳統單 bank 設計會直接擦除作用中映像、寫入新映像。斷電發生在擦除與寫入之間，舊映像毀損、新映像不完整，bootloader 找不到可開機的 FW，機器變磚。OSD 資源若與 FW 映像混在同一 partition，升級還可能誤觸 OSD 字型區，造成 OSD 記憶體溢出或字型亂碼。

### 修正：dual-bank A/B 與單一 commit 出口

修正方式分三層：

1. **Partition 劃分**：SPI flash 被切成 Bank A、Bank B、OSD 資源區、boot header 區，互不重疊。OSD 字型、圖示、menu table 放在 OSD 資源區，FW 升級不得擦除該區。
2. **只寫非作用中 bank**：bootloader 讀取目前的 bank_sel，若作用中是 Bank A，就把新映像寫進 Bank B；反之亦然。舊映像保留，斷電時仍可從舊 bank 開機。
3. **單一 commit 出口**：新映像寫完後先算 CRC32，與來源對比；只有 CRC 正確，才把 bank_sel 切換到新 bank。這個切換動作是唯一的「commit」點，之前任何失敗都不影響舊 bank。

以下為示意程式碼，暫存器地址與 Macro 名稱並非出自公開 datasheet，均標註 `/* 示意地址，非實際晶片規格 */`：

```c
/* 示意地址，非實際晶片規格 */
#define SPI_BANK_A_OFFSET     0x00000000
#define SPI_BANK_B_OFFSET     0x00400000
#define SPI_OSD_RES_OFFSET    0x00700000   /* OSD 資源區，升級不得觸碰 */
#define BOOT_BANK_SEL_ADDR    0x007FF000   /* 示意地址，非實際晶片規格 */
#define BOOT_BANK_SEL_MAGIC   0xA5B5C5D5
#define BOOT_BANK_A           0x00000001
#define BOOT_BANK_B           0x00000002

int fw_dual_bank_upgrade(const uint8_t *new_image, uint32_t image_size)
{
    uint32_t active_bank, target_bank, target_offset;
    uint32_t crc_new, crc_written;

    active_bank = spi_read_reg(BOOT_BANK_SEL_ADDR); /* 示意地址，非實際晶片規格 */
    target_bank = (active_bank == BOOT_BANK_A) ? BOOT_BANK_B : BOOT_BANK_A;
    target_offset = (target_bank == BOOT_BANK_A) ? SPI_BANK_A_OFFSET : SPI_BANK_B_OFFSET;

    /* 1. 擦除目標 bank，不碰作用中 bank，也不碰 OSD 資源區 */
    for (uint32_t off = 0; off < 0x00400000; off += 4096) {
        if (flash_erase_sector(target_offset + off) != 0) return -1;
    }

    /* 2. 頁寫入新映像 */
    for (uint32_t off = 0; off < image_size; off += 256) {
        if (flash_program_page(target_offset + off, new_image + off, 256) != 0) return -1;
    }

    /* 3. 驗證 CRC，不通過則不切換 bank，保留舊映像 */
    crc_new = calc_image_crc32((uint32_t)new_image, image_size);
    crc_written = calc_image_crc32(target_offset, image_size);
    if (crc_new != crc_written) return -2;

    /* 4. 單一 commit：切換 bank_sel */
    spi_write_reg(BOOT_BANK_SEL_ADDR, target_bank); /* 示意地址，非實際晶片規格 */
    return 0;
}
```

Bootloader 開機時也會檢查所選 bank 的 CRC，若不符或連續開機失敗超過上限（boot count），自動切換到另一 bank，避免開機黑畫面循環。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某機種在 DVT 階段進行 OTA 韌體升級測試，升級過程中若斷電，scaler FW 無法開機，出現黑畫面無 OSD、無輸入源切換，必須回廠透過 ISP 重燒。客訴分析指出：單 bank SPI flash 寫入期間若斷電，舊映像與新映像可能同時毀損，沒有回退機制。OSD 字型與圖示資源也儲存在同一顆 SPI flash，partition 劃分不當會導致 OSD 資源區被覆寫或記憶體溢出。

修正後，升級改為 dual-bank A/B 與單一 commit 出口，斷電後機器仍能從舊 bank 開機，OSD 資源區亦不受升級影響，客訴率顯著下降。

## 新人避坑指南

1. **不要就地擦除作用中映像**：升級時務必保留舊映像直到新映像驗證通過，否則斷電就是磚機。
2. **OSD 資源與 FW 映像分開放**：OSD 字型、圖示、menu table 有自己的 partition，升級時不得擦除，否則會出現 OSD 記憶體溢出或字型亂碼。
3. **CRC 驗證不能省**：寫完新映像後一定要算 CRC 對比，不通過就不切換 bank_sel。
4. **boot count 與 boot limit**：連續開機失敗超過上限時自動切換 bank，避免陷入開機黑畫面循環。
5. **暫存器地址不要亂寫**：非公開 datasheet 的地址與 Macro 必須註解 `/* 示意地址，非實際晶片規格 */`，實際量產前要對照手上的 NDA 文件替換。

## 思考題

如果升級過程中斷電發生在「寫完新映像、算完 CRC、但還沒切換 bank_sel」這個瞬間，機器重開機後會從哪個 bank 開機？為什麼？

<details>
<summary>提示與參考答案</summary>

會從舊 bank 開機。因為 bank_sel 尚未切換，bootloader 仍讀到舊的 bank_sel 值，從舊 bank 啟動。新映像雖然已寫入目標 bank，但尚未被標記為作用中，下次升級時仍會被當作目標 bank 重新寫入。
</details>

## 參考資料

1. U-Boot 官方文件，Partitions：https://docs.u-boot.org/en/latest/usage/partitions.html（官方）
2. U-Boot 官方文件，Boot Count Limit：https://docs.u-boot.org/en/latest/api/bootcount.html（官方）
3. Linux Kernel 官方文件，SPI NOR framework（kernel 6.1）：https://docs.kernel.org/6.1/driver-api/mtd/spi-nor.html（官方）
4. U-Boot 官方文件，Flat Image Tree (FIT)：https://docs.u-boot.org/en/latest/usage/fit/index.html（官方）
