---
layout: post
title: "夜間 DDC/CI regression 卡在 92%：你的腳本把 ddcutil 當同步 RPC 在用"
date: 2026-10-31
tags: [DDC/CI, MCCS, ddcutil, pytest, 自動化測試, Null Message, flaky]
level: intermediate
prerequisites: ["DDC/CI 與 ddcutil 實作（posts/2026-10-28-ddc-ci-mccs-ddcutil-intro.md）", "工廠色彩校正流程（posts/2026-10-30-factory-color-calibration-takt-time.md）"]
series: "從零成為顯示器架構師"
topic_track: C
roadmap_stage: practitioner
sources_checked: 2026-10-31
description: "夜間 DDC/CI regression 卡住，常因腳本把 ddcutil 當同步 RPC。本文說明等待語意、Null Message 與 setvcp 驗證。"
seo_title: "DDC/CI regression 卡 92%？ddcutil 不是同步 RPC"
difficulty: intermediate
---
> **重點摘要**：DDC/CI 規定 host 送出命令後要等 40–200 ms 再讀回應，Null Message 也可能代表「還沒好」或「不支援」。setvcp 只有 I2C 層的確認，切輸入源這類功能立刻讀回會失敗。腳本要把 ddcutil 當成有等待語意的慢速匯流排，每次讀回確認前都留 settle delay。

## 【前置知識準備】

先講三個類比，新人看完再往下。

**DDC/CI 的等待語意，像掛號看診。** 你把掛號單（Set/Get VCP Feature 封包）遞進診間，護理師會跟你說「請等 40 到 200 秒再回來問結果」。DDC/CI 規格就是這樣：host 送出命令後，要等 40–200 ms（依操作類型）再去讀回應。照規格睡，大概九成的執行時間都在睡覺[^1]。很多螢幕其實回得更快，但也有螢幕需要更久。你如果遞完單子立刻衝進診間問「好了沒」，只會得到「還沒」（這就是 Null Message），不是「看不了病」。

**Null Message 有兩種意思，像「請稍候」和「查無此人」。** 依 DDC/CI Command Interface Standard v1.1（2004 年版）section 6.4（ddcutil 文件引述），display 送 Null Message 給 host 有幾種情況，其中最關鍵的兩種：一是「我還沒準備好回應你」，正確處理是睡久一點再重試；二是有些螢幕乾脆用 Null Message 表示「這個 feature 我不支援」，正確處理是不重試。把「請稍候」當成「查無此人」，你的測試就會亂報 fail；把「查無此人」當成「請稍候」，你會對一個不存在的 feature 白白重試十次，測試慢得像龜。

**setvcp 的 verify，像寄包裹只拿到「已收件」通知。** ddcutil 文件明講：Set VCP Feature 封包送出去，螢幕只在 I2C 層回「收到了」，沒有任何「我執行成功了」的確認。所以 ddcutil 預設會再讀一次值來驗證。但有些 feature，文件直接點名 0x60（Input Source，輸入源切換），這種驗證「可以預期會失敗」，因為切輸入源之後 scaler 要時間完成模式切換，你立刻讀回來當然是舊值或過渡值。

還有一個背景：DisplayPort 上沒有實體的 I2C 時脈線和資料線，DDC/CI 的 I2C 交易是在兩端被轉成 AUX channel 訊息（ddcutil 的「DDC and DisplayPort」頁寫得很清楚）。所以 DP link retrain、模式切換的時候，AUX 忙，DDC/CI 自然慢。這不是 bug，是架構。

## 【系統廠真實血淚案例】

情境模擬（依公開規格推演），非真實客戶或產品事件。

DVT 階段，機種三輸入（DP、HDMI、USB-C），測試台是 Linux 主機跑 nightly DDC/CI regression：pytest 排程，用 ddcutil 對兩台同型 DUT 讀寫 VCP feature（亮度 0x10、輸入源 0x60、電源模式 0xD6），驗證 OSD 狀態機跟 NVRAM 記憶。pass rate 長期卡在 92%，每晚 fail 的 case 都不一樣，單獨重跑又會過。QA 主張是韌體 bug，要求擋 release。

三種典型失敗：

1. `getvcp 10` 回 Null Response，重試十次後放棄。
2. `setvcp 60 0x0f` 切輸入源後 verify 讀回值不對，判 fail，但畫面明明切過去了。
3. 兩台 DUT 並行跑特別容易 fail，序列跑幾乎全綠。

拿 scaler 的 UART log 對時間軸，fail 的時間點 scaler 正在 input switch 或 link retrain。逐條對 ddcutil 官方文件，根因有四層，全在腳本側：

**第一層：無視 40–200 ms 等待語意。** 腳本用預設 `--sleep-multiplier 1.0`，DUT 在 input switch 期間回應比預設慢，撞上 Null Response 又沒有退讓重試。

**第二層：Null Message 語意不分。** 腳本自己解析 `--brief` 輸出，把「not ready」直接當 fail。ddcutil 本身會在偵測階段讀一個必然不存在的 feature 0x00，判斷這台螢幕是不是用 Null Message 表示不支援，然後決定要不要重試；我們的腳本把這套邏輯丟掉了。

**第三層：對 0x60 做立即 verify。** 這是 ddcutil 文件明講會失敗的操作。切輸入源後立刻 read-back，讀到舊值就判 fail，其實畫面已經切好了。這條是純腳本設計錯誤。

**第四層：並行 worker 污染 dynamic sleep 統計。** ddcutil 預設開 dynamic sleep，統計存在 `$HOME/.cache/ddcutil/stats`，跨執行共用。兩個 pytest worker 同時跑，兩個 ddcutil process 對同一份統計檔讀寫，sleep multiplier 的學習互相干擾。另外 capabilities 是 ddcutil 最貴、也最容易在邊際 I2C 連線上失敗的操作（文件原話），我們的腳本居然在每個 test case 都重新呼叫一次。

修正後的包裝層核心（完整版在研究筆記）：

```python
# ddc_ci_client.py（節錄）
# 已查證：ddcutil 指令語法與選項出自 ddcutil 官方文件；VCP 0x10/0x60/0xD6 為 MCCS 公開定義。
# 示意：SETTLE_MS、退讓常數為本專案調校值，非規格數字。

BASE_OPTS = [
    "--disable-dynamic-sleep",   # 並行 worker 共用 ~/.cache/ddcutil/stats 會互相污染
    "--sleep-multiplier", "1.3", # 示意調校值，各 bench 用 --stats tries 實測
    "--maxtries", "3,6,3",       # write-only, write-read, multi-part
    "--brief",
]

def switch_input(bus: int, new_src: str) -> None:
    # 0x60 的 verify 可預期失敗（ddcutil 文件明講）→ noverify + settle + 讀回確認
    ddcutil(bus, ["setvcp", "60", new_src, "--noverify"])
    time.sleep(0.8)                       # 示意值：等 scaler 完成模式切換
    cur, _ = get_vcp(bus, "60")
    if cur != new_src:
        time.sleep(0.5)                   # 再退讓一輪
        cur, _ = get_vcp(bus, "60")
        if cur != new_src:
            raise DdcError(f"input switch verify failed: want {new_src}, got {cur}")

def with_backoff(fn, tries: int = 3, base: float = 0.3):
    # 只對 ddc_not_ready 退讓重試；unsupported 直接拋出，不浪費重試
    last = None
    for i in range(tries):
        try:
            return fn()
        except DdcError as e:
            if not str(e).startswith("ddc_not_ready"):
                raise
            last = e
            time.sleep(base * (2 ** i))   # 0.3s, 0.6s, 1.2s（示意值）
    raise last
```

scaler 韌體側也補了一個防禦：input switch 期間對 DDC/CI 請求明確回 Null Message（「not ready」語意），而不是回延遲的舊資料。host 端對 Null Message 有標準處理路徑，對過時資料沒有。

```c
/* ddc_task.c（節錄，示意）
 * 已查證：Null Message 語意出自 DDC/CI spec v1.1 section 6.4（ddcutil 文件引述）。
 * 示意：Scaler_* Macro 為示意，非實際 SDK API。 */
void Scaler_OnInputSwitchStart(void)
{
    Scaler_Ddc_SetNullResponseMode(1);   /* 示意地址，非實際晶片規格 */
}
void Scaler_OnInputSwitchDone(void)
{
    Scaler_Ddc_SetNullResponseMode(0);   /* 示意地址，非實際晶片規格 */
    Scaler_Timer_Start(DDC_AUX_DRAIN_MS, Scaler_Ddc_AuxDrainDone);  /* 示意 */
}
```

修正後 nightly pass rate 回到 99% 以上，剩下的 fail 都是真的韌體問題，QA 跟 FW 團隊終於不用每週開會吵「這是不是測試環境問題」。

## 【新人避坑指南（Mentor's Take）】

### 1. 看懂這個 Bug 的關鍵暫存器/訊號線是哪一個？

這個 case 的「關鍵線」不在 scaler 晶片裡，在三個地方：

- **I2C 匯流排本身**：DDC/CI 跑在 I2C 上（HDMI/DVI 是實體 SDA/SCL 腳，DP 是 輔助通道（AUX）隧道）。DP 輸入的 DDC/CI 變慢，先想 AUX 忙不忙，再想韌體。
- **`~/.cache/ddcutil/stats` 與 `~/.cache/ddcutil/capabilities`**：這兩個檔案是 ddcutil 的跨執行狀態，並行測試時它們就是共享變數，會被污染。
- **VCP feature 0x60（Input Source）**：MCCS 公開定義的 code，也是 ddcutil 文件點名 verify 會失敗的 feature。腳本裡所有對 0x60 的立即 verify 都是地雷。

### 2. 未來寫 Code 或驗證時，如何避免重蹈覆轉？

- 把 ddcutil 當「有等待語意的慢速匯流排」，不是同步 RPC。所有 setvcp 之後的讀回確認，中間都要有 settle delay。
- CI 環境一律 `--disable-dynamic-sleep`；`--sleep-multiplier` 依 bench 實測調校（文件建議用 `--stats tries` 找最佳值），換線材、換 hub、換 DUT 都要重調。
- 用 `--bus` 綁定 DUT，不要用 `--display`，偵測順序會漂移。
- 重試政策要分類錯誤：通訊類（not ready）退讓重試，語意類（unsupported）直接失敗。ddcutil 預設的 write-read 重試上限是 10 次，對不存在的 feature 硬重試，一個 case 就多燒好幾秒。
- capabilities 量一次存檔，別每個 test case 重複呼叫，它是最貴也最容易失敗的操作。
- 每筆測試結果綁 FW build hash、DUT serial、bench id、ddcutil 參數 hash。不然 flaky 報告永遠對不到版本。
- flaky 先看 scaler UART log 對時間軸：fail 那一刻 scaler 在做什麼？在 input switch 就是時序問題，不在就是真的韌體問題。

### 3. 思考題

ddcutil 在偵測階段會刻意去讀一個「必然不存在」的 VCP feature 0x00，用回應判斷這台螢幕屬於「Null Message = not ready」還是「Null Message = unsupported」哪一派。

問題：如果你的 scaler 韌體在偵測階段對 feature 0x00 回了一個「正常的 unsupported 回應」（帶 Unsupported Feature 位元的標準回應），而量產機種 A 卻回 Null Message，兩種實作對 ddcutil 的行為、對你產線測試腳本的執行時間，分別會造成什麼差異？提示：去讀 ddcutil 的「DDC Null Message」頁，想想第二段的「unfortunate consequence」講的是什麼。

## 參考資料

1. ddcutil 官方文件 — Command Overview（官方）：https://www.ddcutil.com/commands/
2. ddcutil 官方文件 — Performance and Tuning Options（官方；40–200 ms 等待、--sleep-multiplier、--maxtries 預設值、dynamic sleep 統計檔、capabilities 快取）：https://www.ddcutil.com/performance_options/
3. ddcutil 官方文件 — setvcp（官方；Set VCP Feature 無執行確認、預設 verify、0x60 verify 可預期失敗、--noverify）：https://www.ddcutil.com/command_setvcp/
4. ddcutil 官方文件 — DDC Null Message（官方；引述 DDC/CI Command Interface Standard v1.1, 2004-10-29, section 6.4）：https://www.ddcutil.com/ddc_null_response/
5. ddcutil 官方文件 — DDC and DisplayPort（官方；DP 無實體 SCL/SDA，I2C-over-AUX 隧道）：https://www.ddcutil.com/displayport/

> 提醒：DDC/CI 與 MCCS 規格全文需 VESA 授權，本文僅引用 ddcutil 官方文件轉述的公開內容；撰寫正式測試文件時請對照手上的授權版本。

[^1]: ddcutil 官方文件 — Performance and Tuning Options，見參考資料 2。網頁文件，章節待查證。
