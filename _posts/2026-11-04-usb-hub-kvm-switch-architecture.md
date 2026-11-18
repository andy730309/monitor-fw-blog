---
layout: post
title: "顯示器內建 USB hub 與 KVM 切換：視訊輸入與 USB 上游埠不同步的三個坑"
date: 2026-11-04
tags: [USB, Hub, KVM, 介面切換, EDID, HPD]
level: intermediate
prerequisites: ["USB 基本概念（tree 架構、hub、下游埠）", "EDID 與 HPD 基本概念", "DDC/CI 與 MCCS 入門"]
series: "從零成為顯示器架構師"
topic_track: A
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "切換視訊輸入後鍵盤滑鼠沒跟著換？說明顯示器內建 USB hub 的 tree 架構、上游埠切換與重新列舉的韌體做法。"
seo_title: "螢幕 USB hub 與 KVM 切換不同步的三個坑"
difficulty: intermediate
---
> **重點摘要**：KVM 功能要求切換視訊輸入時，鍵盤滑鼠也跟著換到對應的主機。USB 是 tree 架構，切換上游埠後，下游裝置必須在新主機下重新列舉。韌體若只切上游埠，沒有對下游埠做 port reset，新主機就看不到這些裝置。

## 前置知識

顯示器內建 USB hub 時，主機（來源端，source）連上游埠，鍵盤滑鼠等裝置連下游埠。USB 採 tree 架構，hub 為內部節點（interior node），裝置為葉節點（leaf）；上游埠對應哪台主機，下游裝置就隨著那條路徑列舉（enumeration）。KVM（鍵盤、視訊、滑鼠切換）的意思是：使用者切換視訊輸入（例如 HDMI 切 DisplayPort）時，鍵盤滑鼠應該跟著換到對應的主機。這需要 scaler FW 把視訊輸入選擇、USB hub 上游埠選擇、下游埠電源與複位，全部做成同步切換，否則會出現「畫面換了，鍵盤滑鼠沒反應」的情況。

相關前置文章：DDC/CI 與 MCCS 入門（posts/2026-10-28-ddc-ci-mccs-ddcutil-intro.md）、EDID 入門（posts/2026-10-29-edid-intro-edid-decode.md）。

## 技術核心

### USB hub tree 架構與埠切換

USB 以 tree 結構組織，host 為根，hub 為內部節點，peripheral 為葉節點。切換 KVM 輸入時，上游埠要指向新主機，下游裝置必須在新主機下重新列舉。若 FW 只切上游埠不對下游埠做埠複位（port reset）與重新列舉，新主機看不到下游裝置（來源：Linux kernel USB Host Side API，https://www.kernel.org/doc/html/latest/driver-api/usb/usb.html）。

### 視訊與 USB 同步切換

視訊輸入切換涉及 EDID 宣告與 HPD 脈衝。切換後新輸入端的 EDID 需重新向主機宣告，HPD 脈衝寬度需符合視訊介面規格，否則主機不重新讀 EDID、不重新執行連結訓練（link training）。USB 上游埠切換與視訊切換必須以單一 commit 出口完成，避免視訊與 USB 協商不同步。

### 韌體修正示意

以下程式碼中的暫存器地址與 Macro 名稱非出自公開 datasheet，皆標註 `/* 示意地址，非實際晶片規格 */`；DDC/CI 位址 0x37 與 VCP 0x60 已查證（MCCS 公開定義，ddcutil 文件）。

```c
/* 示意地址，非實際晶片規格 */
#define REG_KVM_INPUT_SEL     0x4A   /* KVM 輸入選擇：0=HDMI, 1=DP */
#define REG_USB_HUB_UPSTREAM  0x4C   /* USB hub 上游埠選擇 */
#define REG_USB_PORT_POWER    0x4E   /* 下游埠電源開關 */
#define REG_USB_PORT_RESET    0x50   /* 下游埠複位 */
#define REG_SWITCH_STATUS     0x52   /* 切換狀態回讀，bit7=busy */

/* DDC/CI VCP code：已查證（DDC/CI 位址 0x37，MCCS VCP 0x60 = Input Source） */
#define MCCS_VCP_INPUT_SOURCE 0x60

bool kvm_switch_input(int input)
{
    uint8_t upstream_val = (input == 1) ? 0x01 : 0x00;

    /* 1. 切換視訊輸入（HDMI/DP），HPD 脈衝依 panel 規格寬度 */
    Scaler_Write_Register_Byte(REG_KVM_INPUT_SEL, upstream_val); /* 示意地址，非實際晶片規格 */
    Scaler_Delay_ms(5);

    /* 2. 切換 USB hub 上游埠，對應新主機 */
    Scaler_Write_Register_Byte(REG_USB_HUB_UPSTREAM, upstream_val); /* 示意地址，非實際晶片規格 */
    Scaler_Delay_ms(5);

    /* 3. 下游埠重新列舉：關電源→開電源→複位→釋放複位→等待列舉 */
    Scaler_Write_Register_Byte(REG_USB_PORT_POWER, 0x00); /* 示意地址，非實際晶片規格 */
    Scaler_Delay_ms(100);
    Scaler_Write_Register_Byte(REG_USB_PORT_POWER, 0x03); /* 示意地址，非實際晶片規格 */
    Scaler_Delay_ms(50);
    Scaler_Write_Register_Byte(REG_USB_PORT_RESET, 0x03); /* 示意地址，非實際晶片規格 */
    Scaler_Delay_ms(20);
    Scaler_Write_Register_Byte(REG_USB_PORT_RESET, 0x00); /* 示意地址，非實際晶片規格 */
    Scaler_Delay_ms(200);

    /* 4. 回讀確認切換完成 */
    /* ... busy 旗標回讀，示意實作 ... */

    /* 5. 透過 DDC/CI 回應輸入源變更（VCP 0x60，已查證） */
    Scaler_Write_Register_Byte(MCCS_VCP_INPUT_SOURCE, (uint8_t)input); /* 示意地址，非實際晶片規格 */

    return true;
}
```

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠 4K144 顯示器機種內建 USB hub 與 KVM 切換，支援 HDMI 與 DisplayPort 兩組視訊輸入共用一組下游 USB 埠。使用者透過 OSD 切換視訊輸入時，畫面正確切換，但鍵盤滑鼠沒反應，需重新插拔 USB 線才恢復；偶爾切換後下游埠不列設備，必須冷開機才回復。

量測現象：切換後下游 USB 裝置在新主機下不列舉，dmesg 沒有新裝置接上紀錄；HPD 脈衝寬度偏窄，主機未重新讀 EDID。

協定層分析：scaler FW 切換 USB hub 上游埠後，未對下游埠發埠複位與重新列舉；下游裝置仍舊掛在舊的上游路徑上，新主機看不到。此外，下游埠電源開關沒依序開關，裝置在電源不穩定時列舉失敗，FW 也沒有重試機制。

## 新人避坑指南

1. 視訊輸入切換時，USB hub 上游埠必須與視訊輸入同步切換，不要分開兩個步驟，否則畫面與鍵盤滑鼠會對不上主機。
2. 下游 USB 埠切換後，必須執行電源開關→複位→重新列舉序列，並加上 busy 旗標回讀確認，不要假設切換指令下發就完成。
3. HPD 脈衝寬度與 EDID 重新宣告是視訊切換的關鍵，切換後要確保主機重新讀 EDID 與執行連結訓練。
4. scaler 與 USB hub MCU 之間的介面（通常 I2C 或 UART）要有狀態同步與回讀確認，不要只發指令不讀回應。
5. 產線測試要做反覆切換 100 次以上，驗證鍵盤滑鼠每次都正常運作，冷開機與熱切換行為要一致。

## 思考題

USB hub 下游埠複位與重新列舉的標準時序數值（wHubDelay、port reset 持續時間）是多少？這些數值在本地規格庫中沒有，需要查哪份文件？（答案：待查證，需查 USB 2.0/3.2 規格，USB-IF 文件庫可能需會員下載）

## 參考資料

1. USB-IF 首頁（官方）：https://www.usb.org/
2. USB-IF Document Library（官方，列出 USB 2.0/3.2/Type-C/PD 規格與測試工具）：https://www.usb.org/documents
3. Linux kernel USB Host Side API（官方，描述 USB tree 結構、hub 作為 interior nodes、peripherals 為 leaves）：https://www.kernel.org/doc/html/latest/driver-api/usb/usb.html
4. VESA About DisplayPort（官方，DisplayPort 介紹與認證資訊）：https://www.vesa.org/about-displayport/
