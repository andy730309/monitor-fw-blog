---
layout: post
title: "Nightly DP 測試一直 flaky？UniTAP 自動化台的三個前置與追溯坑"
date: 2026-10-30
tags: [UniTAP, Unigraf, UCD-500, DisplayPort, HIL, pytest, 自動化測試, regression, DDC/CI]
level: intermediate
prerequisites: ["DPCD 入門：DisplayPort 設定資料結構與 Sink Capability 宣告", "DDC/CI 與 MCCS 入門：用 ddcutil 從電腦控制顯示器"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-10-30
description: "Nightly DP 測試時好時壞？拆解 UniTAP 自動化測試台的 HPD settle、參數來源與追溯三個坑，讓 flaky test 變得可重現。"
difficulty: intermediate
---
> **重點摘要**：Flaky test 比穩定失敗更危險，因為它會養成重跑到綠燈的壞習慣。排查時第一順位是 HPD 與 DUT 端的 debounce，先問這個 test 之前發生了什麼插拔或斷電。修正方法是把手測時自然的等待寫成前置步驟，並讓測試參數只有一個來源。

## 【前置知識準備】

先講兩個名詞，再講一個工程觀念。

**HIL（Hardware-in-the-Loop，硬體在迴路）測試台**：把真的硬體（你的螢幕 DUT）接上真的儀器（訊號產生器/分析儀），用程式控制整輪測試。類比：不是在紙上驗算菜譜，是真的開火試煮一桌菜，而且是機器人幫你煮、整晚煮。

**UCD 系列與 UniTAP**：Unigraf 的 UCD 系列是 DisplayPort/HDMI/USB-C 的訊號產生與分析儀器；官方授權工具頁寫明 UCD-500 Gen2/Gen3 是 VESA DP 2.1 Link Layer CTS 的 reference source/sink，支援到 20 Gbps lane rate，且提供 API/scripting、可 log/analyze link packets 與 AUX transactions。UniTAP 則是 Unigraf 的 Python 測試自動化平台（官方頁原文：Python-based Test Automation Platform），拿來把 UCD 系列整合進你自己的測試系統。官方建議的流程很明確：先在 UCD Console（圖形介面）把 test 參數調好、存進 test library，再由 UniTAP 執行。

**Flaky test（不穩定測試）**：同一份程式、同一份硬體，有時候過、有時候不過，沒有明確因果。工程上要先建立一個觀念：flaky 比穩定 fail 更危險。穩定 fail 至少會逼人修；flaky 會養出「rerun 三次總會綠」的壞習慣，最後整個 CI 的紅燈都沒人理，真 bug 藏在裡面一起過夜。

把這三個東西串起來的工程觀念：**自動化台不是「把手工步驟寫成程式」，而是「把手工時自然發生的等待與重置，明文化成程式裡的前置步驟」**。人測的時候會等、會重插、會看一眼再按下一顆；機器不會，你沒寫它就真的不做。

## 【系統廠真實血淚案例】

> **情境模擬（依公開規格推演）**：以下為虛構的教學情境，非真實客戶、產品或任何特定廠商的事件。

DVT 階段，一台 nightly DP regression bench 上線：PC 跑 pytest，控 UCD-500 Gen3 對某 DP 2.1 sink 機種（情境模擬）跑 link training、DPCD/EDID read-back、CRC video test；DDC/CI 側用 ddcutil 確認輸入源與機台版本。跑了兩週，nightly 失敗率約 4%（示意），集中在兩類：LT 偶發 fail 在 CR/EQ 階段、CRC video 偶發 mismatch。白天工程師上 UCD Console 手動跑同一組 test case 全過。自動化被下指令：「把 retry 加大。」

把 nightly fail 的 log 按時間軸排開才發現不是隨機：失敗都跟在「前一個 test case 做過 AC power cycle 或 HPD 動作」之後。三個根因疊加。

**根因一：test case 之間不重置 link，吃掉 DUT 的緩衝時間。** 舊腳本為了省時間，LT test 直接接在上一輪後面。但 DUT 端有 HPD debounce（去抖）：訊號線上的抖動不能當成真的插拔，所以韌體會故意等一小段時間才認。DP 規格層面，HPD 是 source 觸發 EDID 讀取與 link training 的前提；DUT 端 debounce 要等多久是機種實作（常見設計在 100 ms 量級，具體值依平台文件，待查證）。手動測試時工程師自然會等、會重插螢幕，等效幫 DUT 留了緩衝；自動化把這個緩衝無聲吃掉，於是 source 側看到的 hot-plug 時序與 DUT 內部狀態機偶爾對不齊——這就是那 4% 的來處。

修正：每個 LT/CRC test case 前強制前置。

```python
# 示意包裝層：UniTAP 實際 Python API 簽名屬 SDK 手冊範圍，公開頁未列，
# 以下命名為示意，結構對應 Unigraf 官方「Console 配置 → test library → UniTAP 執行」流程
import time

class UniTapSession:
    def hpd_toggle(self, low_ms=500, settle_ms=1000):
        # 示意 API：斷 HPD → 等 low_ms → 拉 HPD → 等 settle_ms
        # self._dev.hpd_drive(False); time.sleep(...)
        # self._dev.hpd_drive(True);  time.sleep(...)
        ...

    def cold_start_link(self):
        """每個 LT 相關 test 的強制前置：斷 HPD → 重插 → 等穩 → 才准 LT。
        settle 時間下限 >= DUT debounce + EDID 讀取時間，依機種實測，勿抄示意值。"""
        self.hpd_toggle()
```

**根因二：test 參數沒有 single source of truth。** 舊腳本把 lane rate、pattern、timeout 散落在 Python 字典與環境變數，兩台 bench 的同名 test case 實際參數不同。結果 bench A fail、bench B 永遠 green，fail 無法重現也無法二分。Unigraf 官方流程本來就給了答案：參數在 UCD Console 配好、存 test library，程式只負責呼叫。落法是把匯出的參數檔進 git，CI 每次開跑前比對本機 test library 與 canonical 檔的雜湊，不同就 fail-fast——寧可開跑前紅，不要早上八點看 nightly 假綠。

**根因三：fail 沒有綁追溯資訊，retry 還把 flaky 藏起來。** 舊的 JUnit XML 只有 test name 與 exception message，沒有 FW build hash、UCD serial、參數檔版本。拿到 fail 對不到 build，客訴式追查直接斷線。加上 pytest-rerunfailures 無腦三次，flaky 從「該浮出的時序 bug」變「偶爾 green」，CI 信任度崩掉。修正方向：retry 分層——協定層留短 retry 並記錄次數，test 層不做無腦重跑；每筆結果綁 FW build hash + UCD serial + params_hash（可用 pytest 的 user properties 塞進 XML）。

DDC/CI 側則是現成工具的正確用法（已查證 ddcutil 官方 Command Overview）：

```python
# 已查證：ddcutil 指令語法與 --display 選項出自官方文件
import subprocess

def ddc(args):
    return subprocess.run(["ddcutil", "--display", "1"] + args,
                          capture_output=True, text=True, timeout=5)

def force_input_dp1():
    # 已查證：VCP 60h = Input Source；值 0x0F/0x10/0x11 依機種 capabilities（示意值）
    ddc(["--noverify", "setvcp", "60", "0f"])
```

FW 側不用做大事，但要配合：HPD debounce 到點才 upstream assert HPD，讓 source 的 EDID 讀取與 LT 落在 DUT 已準備好的窗口（示意，暫存器與時序值依平台 NDA）。

```c
/* 示意地址與時序，非實際晶片規格 */
#define HPD_DEBOUNCE_MS 120

void Dp_Sink_HandleHpd(bool cable_in)
{
    if (!cable_in) { Dp_Aux_Disable(); return; }
    Timer_Start(HPD_DEBOUNCE_MS);   /* 去抖未過不拉 HPD upstream */
}
```

修正後（模擬情境中）nightly 失敗率降到接近零，剩下的 fail 全部能對到 build 與參數版本，兩台 bench 第一次對得起來。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

- **HPD（Hot Plug Detect）訊號線與 DUT 端 debounce**：自動化 flaky 排查的第一順位。先問「這個 test 之前發生了什麼插拔/斷電」，再看 settle 夠不夠。
- **DPCD 的 Link Status / lane status**：LT fail 時先讀 DPCD 看 CR/EQ 哪段掛的，不要只看儀器 pass/fail 灌了事；UCD-500 官方頁載明可 log/analyze link packets 與 AUX transactions，這些 log 才是根因證據。
- **DDC/CI 的 VCP 60h（Input Source）與機台版本 feature（OEM 自訂）**：bench 開跑前先確認 DUT 在哪個輸入源、跑哪個 build，兩個都錯的話後面全是垃圾資料。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轍？

- **把「人會做的事」寫成前置步驟**：手測會等、會重插、會看一眼——這些都不是迷信，是給硬體狀態機的緩衝。自動化前先錄影自己手工跑一輪，把每一個停頓翻譯成程式裡的 sleep 或 handshake。
- **參數只有一個家**：UCD Console 的 test library（官方流程）或 git 裡的 canonical 檔，二選一但只選一個；CI 比對雜湊，不同就別開跑。
- **結果必須綁身份**：FW build hash、儀器 serial、參數版本、bench ID。沒有這四樣，fail 無法重現，你也無法向 ME/PE 證明不是你的治具。
- **對 flaky 零容忍**：rerun 只准用在「已立案、已知原因、有到期日」的項目上。無腦三次重跑是把定時炸彈包裝成綠燈。
- **timeout 要分層**：DDC/CI 這種協定操作設秒級 timeout（失敗分「無回應/值不符/例外」），儀器長測試另設總預算；昨天校正站的 DDC wrapper 結論直接複用，不要一站一套。

### 3. 思考題

Unigraf 官方頁寫明 UCD-500 Gen2/Gen3 是 VESA DP 2.1 Link Layer CTS 授權工具、支援 up to 20 Gbps lane rate，且「UI for desktop use, API and scripting for Compliance Test automation」。請查 VESA DisplayPort CTS 與你手上的 UniTAP SDK 文件：

1. CTS 裡 source/sink/LTTPR 各自的 link training 測試項目，哪幾項會被「DUT 端 HPD debounce 未過就啟動」影響？為什麼 LTTPR 額外敏感？（提示：LTTPR 的 AUX 通路在 link 沒穩前就可能被 source 掃到。）
2. 你的 nightly 若把 HBR3 與 UHBR10 混在同一 test session，中間不做 cold start，除了 HPD 狀態殘留，還可能踩到什麼 DPCD 狀態？（提示：查 DPCD 的 Link Rate / Lane Count 設定與 training pattern 選擇。）
3. test library 參數檔要不要進 git？若 UCD Console 直接存檔在本機路徑，你會怎麼設計同步與雜湊檢查，才能保證兩台 bench 跑的是同一份參數？

## 參考資料

1. Unigraf — Test Automation（UniTAP 為 Python-based Test Automation Platform；支援 DP/HDMI/USB-C DP Alt Mode；UCD Console 配置 test → 存 test library → UniTAP 執行；TSI 為 C/C++ SDK；UTC-274 含 Python scripting）— 官方：https://www.unigraf.fi/application/test-automation/
2. Unigraf — Production Line Testing（TSI SDK：test cases + macros、command line、NI TestStand 相容；UCD-240/301/323 產線測試工具）— 官方：https://www.unigraf.fi/application/production/
3. VESA — Authorized Test Tools（Unigraf UCD-500 Gen2/Gen3：DP 2.1 Link Layer CTS 授權工具、reference source/sink、up to 20 Gbps、API and scripting for Compliance Test automation、log/analyze link packets 與 AUX transactions、manage DPCD and DisplayID/EDID；UCD-400：DP 1.4a Link Layer + DSC）— 官方：https://vesa.org/authorized-test-tools/
4. Unigraf — 首頁（VESA DP Link Layer、DP HDCP、Dolby Vision、HDR10+ 授權測試工具供應商）— 官方：https://www.unigraf.fi/
5. ddcutil Documentation — Command Overview（detect/capabilities/getvcp/setvcp/scs；--display/--bus 選擇 display）— 官方（工具專案文件）：https://www.ddcutil.com/commands/

提醒：UCD/UniTAP 的詳細 Python API 簽名、test case 名稱與 DP CTS 逐項對應表需對照 Unigraf SDK 手冊與 VESA CTS 會員文件，本文儀器 API 命名皆為示意；DUT 端 HPD debounce 時間依平台 NDA 或實測，勿直接抄文中的示意值。
