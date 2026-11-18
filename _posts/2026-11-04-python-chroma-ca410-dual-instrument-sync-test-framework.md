---
layout: post
title: "產線白平衡校正卡在重測？Chroma 2238 與 CA-410 雙儀器同步 + DDC/CI 閉式校正新手指南"
date: 2026-11-04
tags: [DDC/CI, MCCS, 自動化測試, 產線校正, Chroma, CA-410, Python]
level: intermediate
prerequisites: ["DDC/CI 與 MCCS 入門：用 ddcutil 控制顯示器", "產線白平衡校正閉式解：RGB gain 收斂演算法與 DDC/CI 寫入時序"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-11-04
description: "白平衡校正站重測率飆高？用 Python 同步 Chroma 2238 與 CA-410，並修正 DDC/CI 寫入時序，打造可靠的閉迴路校正。"
seo_title: "Chroma 2238 與 CA-410 雙儀器同步校正指南"
difficulty: intermediate
---
> **重點摘要**：產線白平衡校正要用 Python 同步兩支儀器：Chroma 2238 送測試圖案，CA-410 量測色度。重測率飆高的根因是忽略 2238 的回應、把換圖時間當成 DUT 穩定時間，以及把 DDC/CI ACK 當成執行完成。修正後的腳本用四層 gate 確認每一步真的完成。

## 前置知識

想像你在產線站前，手邊有兩支儀器：一支是 Chroma 2238 訊號產生器（負責往監視器送測試圖案），一支是 Konica Minolta CA-410 彩度計（負責量測螢幕色度與亮度）。你要用 Python 腳本把這兩支儀器串起來，再透過 DDC/CI（Display Data Channel Command Interface，顯示資料通道命令介面）寫入監視器的 RGB gain，讓白平衡校正到目標色度。這就像請兩位工人配合：一位拿畫布（Chroma 送圖案），一位拿色度計（CA-410 量測），中間還要透過對講機（DDC/CI）告訴監視器調整增益。如果兩位工人不同步，量到的就會是上一張圖的顏色，校正永遠收不斂。

新手需先懂幾個概念：

- **DDC/CI**：透過 I2C 匯流排從電腦讀寫監視器的 VCP（Virtual Control Panel，虛擬控制面板）。DDC/CI 的 I2C 位址為 0x37，EDID 則是 0x50（已查證：ddcutil 文件、MCCS 公開定義）。
- **MCCS VCP 代碼**：監視器可控制的功能代碼，例如 0x10 是亮度、0x14 是色溫、0x62 是白平衡/RGB gain（視廠商實作而定；已查證：MCCS 公開定義、ddcutil capabilities 輸出）。
- **setvcp 與 getvcp**：setvcp 是寫入設定值，getvcp 是讀回當前值。重要陷阱：setvcp 收到 I2C ACK 只代表匯流排層收到命令，不代表 scaler 已將新 gain 寫入影像管線（已查證：ddcutil 文件）。
- **Chroma 2238**：訊號產生器。公開手冊列出的遠端命令是自家 ASCII 字串（例如 `RUN TIM`、`RUN PTN`，結尾用分號），不是 SCPI；儀器收到命令會先檢查參數，執行正常回 `OK;`，否則回 `NG;` 加錯誤說明（Chroma 2238 User's Manual §3.2，PDF p.65）。手冊沒有列出 `*IDN?`、`*OPC?` 這類 SCPI 查詢命令；回應的實際位元組（是否帶 CR/LF）待查證。
- **CA-410**：Konica Minolta 彩度計，通訊協定為廠商專屬（KM CA-SDK2 或通訊規格，授權條款；待查證：Konica Minolta 公開文件）。
- **I2C-dev**：Linux 核心將 I2C 匯流排暴露為 `/dev/i2c-n` 節點，userspace 程式可透過它讀寫 DDC/CI（已查證：Linux kernel I2C/SMBus 文件）。

## 技術核心

### 根因：為什麼產線白平衡校正會重測率飆高

既有腳本有三個致命問題：

1. **把 Chroma 2238 當 SCPI 儀器用，又沒讀 `OK;`／`NG;`**：2238 的公開命令集沒有 SCPI 查詢命令（手冊 §3.2，PDF p.65）。腳本送 SCPI 查詢等不到預期回應，也沒讀 2238 實際會回的 `OK;`／`NG;`，換圖失敗時無從得知，圖案切換與量測因此不同步。
2. **以換圖時間當 DUT 穩定時間**：2238 切換圖案約 0.2 秒，不等於監視器影像管線穩定。量測過早會抓到舊畫面或過渡幀。
3. **DDC/CI ACK 等於執行完成**：setvcp 只到匯流排層，不代表 gain 已生效。立即 getvcp 讀到的仍是舊值，閉式校正的反饋錯誤，迭代必然震盪。

### 修正：雙儀器同步 + DDC/CI 寫入時序

修正後的腳本採四層 gate：

**Gate 1 — DDC/CI 心跳**：每次迭代前先確認 DUT 仍在線，避免對斷線的監視器寫入 gain。

**Gate 2 — DDC/CI setvcp + settle**：寫入 RGB gain（VCP 0x62）後，固定等待 40–200 ms（依亮度分檔；已查證：ddcutil 建議），再以 getvcp 讀回驗證。若讀回值與設定值不符，重試。

**Gate 3 — Chroma 切換圖案**：發送 `RUN PTN` 後讀 2238 的回應，收到 `NG;` 或逾時就中止（手冊 §3.2，PDF p.65）。收到 `OK;` 只代表儀器已執行換圖命令，DUT 是否穩定仍由 DDC/CI 心跳與量測收斂 gate 判斷。

**Gate 4 — CA-410 量測**：timeout 依亮度分檔，低灰階約需 1 秒（待查證：Konica Minolta 規格），避免固定 timeout 撐不住導致重測。

校正完成後必須發送 MCCS Save Current Settings，將 gain 持久化至 NVRAM；否則斷電後 gain 遺失，造成批量客退。

以下為 Python 核心片段（示意地址皆標註，非實際晶片規格；DDC/CI VCP 代碼與 I2C 位址已查證）：

```python
# DDC/CI I2C 位址：已查證（ddcutil / MCCS）
I2C_ADDR_DDC_CI = 0x37
I2C_ADDR_EDID   = 0x50

# MCCS VCP 代碼：已查證（MCCS 公開定義）
VCP_BRIGHTNESS  = 0x10
VCP_COLOR_TEMP  = 0x14
VCP_WHITE_BALANCE = 0x62

# DDC/CI 等待：已查證（ddcutil 文件，40–200 ms）
DDC_CI_SET_WAIT_MS = 80

# 示意地址，非實際晶片規格
SCALER_COMMIT_DONE_FLAG = 0x1F50  /* 示意地址，非實際晶片規格 */


class DdcCiClient:
    def setvcp(self, vcp_code: int, value: int, wait_ms: int = DDC_CI_SET_WAIT_MS) -> bool:
        # 寫入 VCP 後等待 settle，再 getvcp 讀回驗證
        # i2c-dev 寫入 0x37，VCP 代碼 + 值（底層函式名稱為示意）
        time.sleep(wait_ms / 1000.0)
        readback = self.getvcp(vcp_code)
        return readback == value  # 示意邏輯，實作須解析 DDC/CI Reply 封包

    def save_current_settings(self) -> bool:
        # 將 gain 持久化至 NVRAM，避免斷電遺失（VCP 代碼視廠商實作，待查證）
        return True  # 示意
```

多 DUT 並行時，CA-410 與 Chroma 為共享資源，須以 `threading.Lock` 與 pyserial exclusive 互斥，並以 `--bus/--sn` 綁定實體匯流排與序號，杜絕量測值串台與 gain 寫錯 DUT。

## 真實血淚案例

情境模擬（依公開規格推演），非真實客戶或產品事件。

某系統廠 ODM 監視器產線，白平衡校正站重測率從 4% 飆到 18%。客訴回報：出貨後隔天色彩又跑掉，整批偏色。工程師抽樣發現，校正站的 Python 腳本把 Chroma 2238 當標準 SCPI 儀器，送查詢指令等待回應，卻沒有讀 2238 實際會回的 `OK;`／`NG;`；同時以 0.2 秒換圖時間當 DUT settle，CA-410 量到的其實是上一張圖的顏色。DDC/CI setvcp 寫入 gain 後立即 verify，讀到的仍是舊值，閉式校正以錯誤反饋繼續調整，gain 來回震盪，終於收斂時已超過儀器精度 ±0.002 的門檻，判定為「假收斂」。更嚴重的是，腳本沒有發送 Save Current Settings，監視器斷電重開後 gain 回到出廠預設，客戶開機就看到偏色，造成批量客退。

修正後：加入 DDC/CI 心跳 gate、setvcp 後 settle + getvcp 讀回驗證、CA-410 依亮度分檔 timeout、校正完成後 Save Current Settings 持久化，並將校正資料與 DUT 序號綁定上傳 MES。重測率從 18% 降回 4% 以下，斷電重驗不再翻船。

## 新人避坑指南

1. **不要把 DDC/CI ACK 當成執行完成**：setvcp 只到匯流排層，寫入後必須 settle 並 getvcp 讀回驗證，否則閉式校正讀到舊值。
2. **不要把儀器換圖時間當 DUT 穩定時間**：Chroma 2238 切換圖案約 0.2 秒，不等於監視器影像管線輸出穩定，須實測標定 settle 時間。
3. **不要用固定 timeout 量測所有灰階**：CA-410 低灰階量測較慢（約 1 秒），固定 timeout 撐不住會導致重測，須依亮度分檔。
4. **多 DUT 並行要綁實體位址**：--bus/--sn 綁定 I2C 匯流排與序號，避免 ttyUSB 漂移與儀器串台。
5. **校正完別忘了 Save Current Settings**：gain 不持久化至 NVRAM，斷電後就遺失，客戶開機見偏色。
6. **非公開晶片暫存器一律標註示意**：Scaler FW 內部地址若非出自公開 datasheet，必須在註解寫 `/* 示意地址，非實際晶片規格 */`，絕不宣稱是真實 RTD/Novatek/MStar 規格。

## 思考題

DDC/CI setvcp 寫入 RGB gain 後，為什麼不能立即呼叫 getvcp 驗證，而必須先等待一段時間？這段等待時間應該怎麼決定？

<details>
<summary>提示（點擊展開）</summary>
setvcp 的 I2C ACK 只表示匯流排層收到命令，scaler 需要時間將新 gain 寫入影像管線並輸出。等待時間須依 panel 與 scaler 實測標定，ddcutil 文件建議 40–200 ms，但實際值因機種而異（待查證：目標 scaler 規格）。
</details>

## 參考資料

1. Linux kernel I2C/SMBus Subsystem 文件（官方，標準規格）：https://www.kernel.org/doc/html/latest/i2c/
2. VESA 官方網站（DisplayPort / DisplayHDR / 標準規格，官方）：https://www.vesa.org/
3. Chroma ATE 官方網站（Video & Color Test Solutions、訊號產生器產品頁，官方）：https://www.chromaate.com/
4. ddcutil GitHub 官方儲存庫（DDC/CI 與 MCCS VCP 代碼、I2C 位址 0x37/0x50，官方）：https://github.com/rockowitz/ddcutil
5. ddcutil 官方文件網站（DDC/CI 40–200 ms 等待語意、setvcp/getvcp 行為、MCCS VCP 定義，官方）：https://www.ddcutil.com/
6. Chroma ATE，Video Pattern Generator 2238 User's Manual（§3.2 命令格式與 OK/NG 回應，PDF p.65；§3.2.2 General Commands `RUN TIM`／`RUN PTN`，PDF p.66；PDF 由代理商網站公開）：https://www.acquisys.fr/wp-content/uploads/2018/06/en_2238_usermanual_1709rv.pdf

> 說明：CA-410 通訊規格與 Chroma 2238 完整命令集為廠商專屬文件，須取得 Konica Minolta 與 Chroma 授權文件後補充；本文未涉及 NDA 內容，讀者請對照手上的 NDA 規格。
