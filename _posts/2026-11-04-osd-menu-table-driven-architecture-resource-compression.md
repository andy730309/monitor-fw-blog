---
layout: post
title: "OSD 選單卡半秒、冒黑塊？table-driven 架構與資源壓縮的三個坑"
date: 2026-11-04
tags: [OSD, memory, scaler, firmware]
level: intermediate
prerequisites: ["Scaler FW 架構（MCU core、ISR、task loop/RTOS）通論", "DDC/CI 與 MCCS 入門"]
series: "從零成為顯示器架構師"
topic_track: B
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "OSD 選單卡頓、冒黑塊，常是選單表與字型塞滿 SRAM。本文說明 table-driven 架構、資源壓縮與 ISR 分工的修正方式。"
difficulty: intermediate
---
> **重點摘要**：Scaler 給 OSD 用的 SRAM 很有限，選單表、字型與圖示全放進 RAM，久了就會出現黑塊或當機。修正方法是把選單表與字串移到 flash、壓縮字型與圖示並用固定 block pool，ISR 只設旗標，渲染交給 task。

## 前置知識

顯示器的 OSD（On Screen Display，螢幕顯示選單）是使用者透過 joystick、IR 或按鍵調整亮度、對比、輸入源的介面。OSD 選單通常以「表」來組織：每個選單項目是一個結構體，包含文字、圖示 ID、回調函式與子選單指標。scaler 晶片給 OSD 用的片上 SRAM 非常有限，如果選單表、字型 bitmap 與圖示全部塞進 RAM，長期開機後就會撐爆，出現黑塊、當機或重開機。

DDC/CI（Display Data Channel Command Interface）是讓電腦透過 I2C 從位址 x37 讀寫顯示器設定的介面，底層依賴 VESA MCCS（Monitor Control Command Set）定義的 VCP（Virtual Control Panel）代碼。MCCS 2.2a 規定 VCP 0xCA 為 OSD 開關、0xCC 為 OSD 語言（ddcutil 文件、MCCS 規格）。Linux 核心的 V4L2 文件也把 Video Output Overlay 介面稱為 OSD，透過 VIDIOC_G_FBUF/S_FBUF 存取 framebuffer（Linux 核心文件）。

新人先理解：OSD 不是「畫在畫面上的圖片」，而是 scaler FW 佔用 SRAM 與 CPU 時間來渲染的軟體層。記憶體不夠、ISR 做太多事、malloc 碎片化，是 OSD 失靈的三大根因。

## 技術核心

### 根因：選單表與資源佔滿 SRAM

OSD 選單表若放在 RAM，每個 menu item 結構體（文字指標、圖示 ID、回調函式指標、子選單指標）都要 malloc。一個三層選單輕鬆佔數十 KB SRAM。CJK 字型子集與選單圖示若以 raw bitmap 全部載入，更無法釋放，導致記憶體溢出（memory overflow）覆寫相鄰變數，出現黑塊。

### 修正 1：選單表與字串移至 flash

把選單表宣告為 `const` 並放入 `.rodata` 區段，常駐 flash，不佔 SRAM。字串同樣放在 flash，渲染時直接讀取，不複製到 RAM。

### 修正 2：字型/圖示壓縮與固定 block pool

字型與圖示資源採 RLE 或 LZ 壓縮，儲存在 flash。渲染前解壓到一個固定大小的 block pool，取代執行期 malloc/free，杜絕 heap 碎片化。所有分配回傳值必須檢查 NULL，失敗時降級為文字-only 選單，不得當機。

### 修正 3：ISR 只設旗標，task 渲染

joystick/IR 中斷服務常式（ISR）只設定事件旗標，不直接呼叫選單切換或 render。OSD render task 依旗標處理，並呼叫 `Task_Delay` 讓出 CPU，避免餓死背光 PWM 與 DDC/CI 任務，造成畫面閃爍或 DDC/CI 逾時。

### DDC/CI 與 OSD 的關聯

電腦可透過 ddcutil 寫入 VCP 0xCA（OSD 開關）與 0xCC（OSD 語言），這兩個代碼已在 VESA MCCS 2.2a 中查證。韌體端對應的 setvcp 處理需與 scaler SDK 對齊，實際 I2C 時序屬 NDA 內容，此處為示意。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某 DVT 機連續開關 OSD 選單 30 次後，畫面右下角出現固定黑塊，joystick 無反應，需拔電恢復。量測發現 OSD 選單表與字型佔用 SRAM 超過預算，heap 碎片化導致 malloc 回傳 NULL，render 函式接收 NULL 指標觸發記憶體違規。ISR 直接 render 佔用 CPU 過久，背光 PWM 與 DDC/CI 任務餓死，螢幕閃爍。

修正後：選單表移至 flash、字型壓縮＋固定 block pool、ISR 只設旗標、task 渲染。72 小時 OSD 開關壓力測試後，黑塊與重開機消失。

## 新人避坑指南

1. 看懂關鍵暫存器與訊號線：OSD 的 IRQ 狀態、frame buffer 指標、背光 PWM 訊號。ISR 做太多事會餓死其他任務，優先權數值設反更會讓低優先級中斷搶走 CPU。
2. 未來寫 Code 或驗證：選單表與字串優先放 flash；字型/圖示壓縮後再解壓到固定 pool；所有 malloc 回傳值檢查 NULL；長期開機壓力測試是必做項，不要只測開機後五分鐘。
3. DDC/CI 除錯時記得：ddcutil 的 ack 只代表匯流排層收到，不代表執行完成；寫入後要 settle 並讀回確認，否則會誤判為成功。

## 思考題

如果 OSD 選單表已經全部放在 flash，但長期開機後仍出現黑塊，下一個應該檢查哪個記憶體區域？（答案：檢查字型/圖示資源是否仍在 raw bitmap 佔滿 SRAM，以及 heap 是否碎片化；可用地圖文件與 malloc 追蹤工具確認。）

## 參考資料

- VESA Monitor Control Command Set (MCCS) Standard Version 2.2a, July 13, 2011（VCP 0xCA OSD、0xCC OSD Language）：https://milek7.pl/ddcbacklight/mccs.pdf（非官方鏡像，官方須向 VESA 取得，NDA）
- VESA Display Data Channel Command Interface (DDC/CI) Standard Version 1.1, October 29, 2004：https://milek7.pl/ddcbacklight/ddcci.pdf（非官方鏡像）
- ddcutil 文件（DDC/CI 透過 I2C 位址 x37 存取 MCCS，i2c-dev 核心模組建立 /dev/i2c-N）：https://www.ddcutil.com/（官方）
- ddcutil References（VESA DDC/CI 與 MCCS 規格清單）：https://www.ddcutil.com/bibliography/（官方）
- Linux Kernel 文件：V4L2 Video Output Overlay Interface（又稱 OSD），VIDIOC_G_FBUF/S_FBUF 與 V4L2_CAP_VIDEO_OUTPUT_OVERLAY：https://docs.kernel.org/userspace-api/media/v4l/dev-osd.html（官方）
